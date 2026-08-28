-- service-owner: agent-control

alter table momi_agent_ops.scheduler_route_policies
  add column quarantine_intervention_seconds integer not null default 900 check (
    quarantine_intervention_seconds between 30 and 3600
  );

create table momi_agent_ops.scheduler_issue_quarantines (
  quarantine_id uuid primary key default gen_random_uuid(),
  route_key text not null references momi_agent_ops.scheduler_route_policies(route_key),
  linear_issue_id uuid not null,
  candidate_id uuid not null references momi_agent_ops.scheduler_candidates(candidate_id),
  dispatch_id uuid not null unique references momi_agent_ops.dispatches(dispatch_id),
  quarantined_at timestamptz not null,
  intervention_deadline_at timestamptz not null,
  capacity_released_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (intervention_deadline_at > quarantined_at),
  check (capacity_released_at is null or capacity_released_at >= quarantined_at),
  check (resolved_at is null or resolved_at >= quarantined_at)
);

create unique index scheduler_issue_quarantines_active_issue_idx
  on momi_agent_ops.scheduler_issue_quarantines (route_key, linear_issue_id)
  where resolved_at is null;

create index scheduler_issue_quarantines_intervention_idx
  on momi_agent_ops.scheduler_issue_quarantines (
    intervention_deadline_at, quarantined_at, dispatch_id
  ) where resolved_at is null;

alter table momi_agent_ops.scheduler_issue_quarantines enable row level security;
revoke all on table momi_agent_ops.scheduler_issue_quarantines
  from public, anon, authenticated, service_role;

create or replace function momi_agent_ops.reconcile_scheduler_dispatch_state_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.source_kind <> 'ready_leaf_scheduler' or new.scheduler_candidate_id is null then
    return new;
  end if;
  if new.work_status in ('completed', 'cancelled', 'rejected', 'dead_letter') then
    update momi_agent_ops.scheduler_slots slot set
      state = 'released', lease_expires_at = null,
      released_at = coalesce(slot.released_at, now()), updated_at = now()
    where slot.dispatch_id = new.dispatch_id and slot.state <> 'released';
    update momi_agent_ops.scheduler_candidates candidate set
      generation_state = 'terminal', waiting_reason = null,
      updated_at = now()
    where candidate.candidate_id = new.scheduler_candidate_id
      and candidate.generation = new.scheduler_generation;
  elsif exists (
    select 1 from momi_agent_ops.scheduler_issue_quarantines quarantine
    where quarantine.dispatch_id = new.dispatch_id and quarantine.resolved_at is null
  ) then
    return new;
  elsif new.host_accepted_at is not null or new.work_status = 'active' then
    update momi_agent_ops.scheduler_slots slot set
      state = 'running', lease_expires_at = now() + interval '30 seconds',
      updated_at = now()
    where slot.dispatch_id = new.dispatch_id and slot.state in ('reserved', 'running');
    update momi_agent_ops.scheduler_candidates candidate set
      generation_state = 'running', updated_at = now()
    where candidate.candidate_id = new.scheduler_candidate_id
      and candidate.generation = new.scheduler_generation;
  end if;
  return new;
end;
$$;

insert into momi_agent_ops.scheduler_issue_quarantines (
  route_key, linear_issue_id, candidate_id, dispatch_id,
  quarantined_at, intervention_deadline_at
)
select slot.route_key, candidate.linear_issue_id, slot.candidate_id, slot.dispatch_id,
  slot.updated_at, slot.updated_at + make_interval(
    secs => policy.quarantine_intervention_seconds)
from momi_agent_ops.scheduler_slots slot
join momi_agent_ops.scheduler_candidates candidate using (candidate_id)
join momi_agent_ops.scheduler_route_policies policy
  on policy.route_key = slot.route_key
where slot.state = 'quarantined'
on conflict do nothing;

update momi_agent_ops.dispatches work set
  capability_token_hash = encode(extensions.digest(
    convert_to(gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'),
  wake_capability_token = null
from momi_agent_ops.scheduler_issue_quarantines quarantine
where quarantine.dispatch_id = work.dispatch_id and quarantine.resolved_at is null
  and work.host_accepted_at is null;

create function momi_agent_ops.claim_scheduler_candidate_v3(
  p_route_key text,
  p_owner_id uuid,
  p_release_sha text,
  p_leader_generation bigint,
  p_candidate_id uuid,
  p_candidate_generation bigint,
  p_snapshot_version bigint
) returns table (claimed boolean, dispatch_id uuid) language plpgsql
security invoker set search_path = '' as $$
declare candidate momi_agent_ops.scheduler_candidates%rowtype;
declare result record;
begin
  select queued.* into candidate from momi_agent_ops.scheduler_candidates queued
  where queued.candidate_id = p_candidate_id and queued.route_key = p_route_key;
  if not found then return query select false, null::uuid; return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || candidate.linear_issue_id::text, 0));
  if exists (
    select 1 from momi_agent_ops.scheduler_issue_quarantines quarantine
    where quarantine.route_key = p_route_key
      and quarantine.linear_issue_id = candidate.linear_issue_id
      and quarantine.resolved_at is null
  ) then
    update momi_agent_ops.scheduler_candidates queued set
      waiting_reason = 'issue_quarantined', updated_at = now()
    where queued.candidate_id = p_candidate_id;
    return query select false, null::uuid; return;
  end if;
  select prior.* into result from momi_agent_ops.claim_scheduler_candidate_v2(
    p_route_key, p_owner_id, p_release_sha, p_leader_generation,
    p_candidate_id, p_candidate_generation, p_snapshot_version
  ) prior;
  if not found then return; end if;
  return query select result.claimed, result.dispatch_id;
end;
$$;

create function momi_agent_ops.heartbeat_scheduler_slots_v2(
  p_active_work_ids uuid[]
) returns table (
  extended integer, terminal_released integer, quarantined integer,
  capacity_released integer, active_quarantines integer,
  oldest_quarantine_age_seconds integer, manual_interventions integer
) language plpgsql security invoker set search_path = '' as $$
declare extended_count integer := 0;
declare terminal_released_count integer := 0;
declare quarantined_count integer := 0;
declare capacity_released_count integer := 0;
declare active_quarantine_count integer := 0;
declare oldest_age integer := 0;
declare manual_intervention_count integer := 0;
declare quarantine_inserted boolean;
declare expired_slot record;
begin
  if p_active_work_ids is null or cardinality(p_active_work_ids) > 128 then
    raise exception 'scheduler_heartbeat_invalid' using errcode = '22023';
  end if;

  update momi_agent_ops.scheduler_slots slot set
    lease_expires_at = now() + interval '30 seconds', updated_at = now()
  where slot.dispatch_id = any (p_active_work_ids)
    and slot.state in ('reserved', 'running');
  get diagnostics extended_count = row_count;

  update momi_agent_ops.scheduler_slots slot set
    state = 'released', lease_expires_at = null,
    released_at = coalesce(slot.released_at, now()), updated_at = now()
  from momi_agent_ops.dispatches work
  where work.dispatch_id = slot.dispatch_id
    and work.work_status in ('completed', 'cancelled', 'rejected', 'dead_letter')
    and slot.state <> 'released';
  get diagnostics terminal_released_count = row_count;

  update momi_agent_ops.scheduler_issue_quarantines quarantine set
    resolved_at = coalesce(quarantine.resolved_at, now()), updated_at = now()
  from momi_agent_ops.dispatches work
  where work.dispatch_id = quarantine.dispatch_id
    and work.work_status in ('completed', 'cancelled', 'rejected', 'dead_letter')
    and quarantine.resolved_at is null;

  for expired_slot in
    select slot.slot_id, slot.route_key, slot.candidate_id, slot.dispatch_id,
      candidate.linear_issue_id, policy.quarantine_intervention_seconds
    from momi_agent_ops.scheduler_slots slot
    join momi_agent_ops.scheduler_candidates candidate using (candidate_id)
    join momi_agent_ops.scheduler_route_policies policy
      on policy.route_key = slot.route_key
    join momi_agent_ops.dispatches work using (dispatch_id)
    where slot.state in ('reserved', 'running')
      and slot.lease_expires_at <= now()
      and not (slot.dispatch_id = any (p_active_work_ids))
      and work.work_status not in ('completed', 'cancelled', 'rejected', 'dead_letter')
    order by slot.created_at, slot.slot_id
    for update of slot
  loop
    quarantine_inserted := false;
    update momi_agent_ops.scheduler_slots slot set
      state = 'quarantined', updated_at = now()
    where slot.slot_id = expired_slot.slot_id;
    update momi_agent_ops.dispatches work set
      capability_token_hash = encode(extensions.digest(
        convert_to(gen_random_uuid()::text, 'UTF8'), 'sha256'), 'hex'),
      wake_capability_token = null
    where work.dispatch_id = expired_slot.dispatch_id and work.host_accepted_at is null;
    insert into momi_agent_ops.scheduler_issue_quarantines (
      route_key, linear_issue_id, candidate_id, dispatch_id,
      quarantined_at, intervention_deadline_at
    ) values (
      expired_slot.route_key, expired_slot.linear_issue_id,
      expired_slot.candidate_id, expired_slot.dispatch_id, now(),
      now() + make_interval(secs => expired_slot.quarantine_intervention_seconds)
    ) on conflict do nothing returning true into quarantine_inserted;
    if quarantine_inserted then
      quarantined_count := quarantined_count + 1;
    end if;
  end loop;

  with released_slots as (
    update momi_agent_ops.scheduler_slots slot set
      state = 'released', lease_expires_at = null,
      released_at = coalesce(slot.released_at, now()), updated_at = now()
    from momi_agent_ops.scheduler_issue_quarantines quarantine
    where quarantine.dispatch_id = slot.dispatch_id
      and quarantine.resolved_at is null
      and quarantine.intervention_deadline_at <= now()
      and slot.state = 'quarantined'
    returning slot.dispatch_id
  )
  update momi_agent_ops.scheduler_issue_quarantines quarantine set
    capacity_released_at = coalesce(quarantine.capacity_released_at, now()),
    updated_at = now()
  where quarantine.dispatch_id in (select dispatch_id from released_slots)
    and quarantine.capacity_released_at is null;
  get diagnostics capacity_released_count = row_count;

  select count(*)::integer,
    coalesce(max(extract(epoch from (now() - quarantine.quarantined_at)))::integer, 0),
    count(*) filter (where quarantine.intervention_deadline_at <= now())::integer
  into active_quarantine_count, oldest_age, manual_intervention_count
  from momi_agent_ops.scheduler_issue_quarantines quarantine
  where quarantine.resolved_at is null;

  return query select extended_count, terminal_released_count, quarantined_count,
    capacity_released_count, active_quarantine_count, oldest_age,
    manual_intervention_count;
end;
$$;

create function momi_agent_ops.resolve_scheduler_issue_quarantine_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.work_status in ('completed', 'cancelled', 'rejected', 'dead_letter') then
    update momi_agent_ops.scheduler_issue_quarantines quarantine set
      resolved_at = coalesce(quarantine.resolved_at, now()), updated_at = now()
    where quarantine.dispatch_id = new.dispatch_id and quarantine.resolved_at is null;
  end if;
  return new;
end;
$$;

create trigger resolve_scheduler_issue_quarantine_v1
after update of work_status on momi_agent_ops.dispatches
for each row execute function momi_agent_ops.resolve_scheduler_issue_quarantine_v1();

grant all on function momi_agent_ops.claim_scheduler_candidate_v3(
  text, uuid, text, bigint, uuid, bigint, bigint
), momi_agent_ops.heartbeat_scheduler_slots_v2(uuid[]) to service_role;

revoke all on function momi_agent_ops.claim_scheduler_candidate_v3(
  text, uuid, text, bigint, uuid, bigint, bigint
), momi_agent_ops.heartbeat_scheduler_slots_v2(uuid[]),
  momi_agent_ops.resolve_scheduler_issue_quarantine_v1()
  from public, anon, authenticated, service_role;
