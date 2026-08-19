-- service-owner: agent-control

create table momi_agent_ops.scheduler_route_policies (
  route_key text primary key check (length(route_key) between 1 and 1000),
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  base_branch text not null check (base_branch ~ '^[A-Za-z0-9._/-]+$'),
  host_dispatch_url text not null check (
    host_dispatch_url ~ '^https://[^[:space:]]+/v1/dispatch$'
  ),
  mode text not null default 'disabled' check (mode in ('disabled', 'observe', 'enabled')),
  required_labels text[] not null default array['implementation', 'ready-package']::text[],
  max_concurrent integer not null default 1 check (max_concurrent between 1 and 20),
  implementation_limit integer not null default 1 check (implementation_limit between 1 and 20),
  coordinator_limit integer not null default 1 check (coordinator_limit between 1 and 20),
  shared_limit integer not null default 1 check (shared_limit between 1 and 20),
  acceptance_issue_ids uuid[] not null default '{}'::uuid[],
  accepted_release_sha text check (
    accepted_release_sha is null or accepted_release_sha ~ '^[0-9a-f]{40}$'
  ),
  acceptance_completed_at timestamptz,
  provider_retry_count integer not null default 0 check (provider_retry_count between 0 and 1000000),
  next_provider_attempt_at timestamptz not null default now(),
  last_provider_error_code text check (
    last_provider_error_code is null or length(last_provider_error_code) between 1 and 120
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository, base_branch, host_dispatch_url),
  check (cardinality(required_labels) between 1 and 12),
  check (implementation_limit <= max_concurrent),
  check (coordinator_limit <= max_concurrent),
  check (shared_limit <= max_concurrent),
  check (
    (mode = 'disabled' and cardinality(acceptance_issue_ids) = 0)
    or (mode = 'observe' and cardinality(acceptance_issue_ids) between 1 and 20)
    or (mode = 'enabled' and cardinality(acceptance_issue_ids) = 0
      and accepted_release_sha is not null and acceptance_completed_at is not null)
  )
);

insert into momi_agent_ops.scheduler_route_policies (
  route_key, repository, base_branch, host_dispatch_url
)
select
  mapping.repository || '@' || mapping.base_branch || '|' || mapping.host_dispatch_url,
  mapping.repository, mapping.base_branch, mapping.host_dispatch_url
from momi_agent_ops.project_mappings mapping
where mapping.active
  and mapping.repository = 'thedoughmonster/momi-symphony'
  and mapping.base_branch = 'main'
  and mapping.host_dispatch_url is not null
on conflict (route_key) do nothing;

create table momi_agent_ops.scheduler_leaders (
  route_key text primary key references momi_agent_ops.scheduler_route_policies(route_key),
  owner_id uuid not null,
  fencing_generation bigint not null check (fencing_generation > 0),
  lease_expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table momi_agent_ops.scheduler_candidates (
  candidate_id uuid primary key default gen_random_uuid(),
  linear_project_id uuid not null references momi_agent_ops.project_mappings(linear_project_id),
  route_key text not null references momi_agent_ops.scheduler_route_policies(route_key),
  linear_issue_id uuid not null,
  linear_issue_identifier text not null check (length(linear_issue_identifier) between 1 and 80),
  linear_issue_url text check (
    linear_issue_url is null or linear_issue_url ~ '^https://linear\.app/'
  ),
  issue_state text not null check (length(issue_state) between 1 and 120),
  priority integer,
  issue_created_at timestamptz,
  issue_updated_at timestamptz,
  labels text[] not null,
  adapter_dispatchable boolean not null,
  dispatchability_reasons text[] not null default '{}'::text[],
  scheduler_eligible boolean not null,
  waiting_reason text,
  generation bigint not null default 0 check (generation >= 0),
  generation_state text not null check (generation_state in (
    'waiting', 'eligible', 'claimed', 'running', 'terminal', 'stale'
  )),
  snapshot_version bigint not null default 1 check (snapshot_version > 0),
  last_eligible boolean not null,
  last_reconciled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (linear_project_id, linear_issue_id),
  check (cardinality(labels) <= 250),
  check (cardinality(dispatchability_reasons) <= 32),
  check (waiting_reason is null or length(waiting_reason) between 1 and 120),
  check ((generation = 0 and generation_state = 'waiting') or generation > 0)
);

alter table momi_agent_ops.dispatches
  alter column receipt_delivery_id drop not null,
  add column source_kind text not null default 'linear_action' check (
    source_kind in ('linear_action', 'ready_leaf_scheduler')
  ),
  add column scheduler_candidate_id uuid
    references momi_agent_ops.scheduler_candidates(candidate_id),
  add column scheduler_generation bigint,
  add constraint dispatch_source_shape check (
    (source_kind = 'linear_action' and receipt_delivery_id is not null
      and scheduler_candidate_id is null and scheduler_generation is null)
    or
    (source_kind = 'ready_leaf_scheduler' and receipt_delivery_id is null
      and scheduler_candidate_id is not null and scheduler_generation > 0
      and action = ('exec' || 'ute-run'))
  );

create unique index dispatches_scheduler_generation_once_idx
  on momi_agent_ops.dispatches (scheduler_candidate_id, scheduler_generation)
  where source_kind = 'ready_leaf_scheduler';

create table momi_agent_ops.scheduler_slots (
  slot_id uuid primary key default gen_random_uuid(),
  route_key text not null references momi_agent_ops.scheduler_route_policies(route_key),
  action_class text not null check (action_class in (
    'implementation', 'coordinator', 'shared_non_execution'
  )),
  candidate_id uuid not null references momi_agent_ops.scheduler_candidates(candidate_id),
  candidate_generation bigint not null check (candidate_generation > 0),
  dispatch_id uuid not null unique references momi_agent_ops.dispatches(dispatch_id),
  leader_generation bigint not null check (leader_generation > 0),
  state text not null check (state in ('reserved', 'running', 'quarantined', 'released')),
  lease_expires_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidate_id, candidate_generation),
  check (
    (state = 'released' and lease_expires_at is null and released_at is not null)
    or (state <> 'released' and lease_expires_at is not null and released_at is null)
  )
);

create index scheduler_candidates_claimable_idx
  on momi_agent_ops.scheduler_candidates (
    route_key, scheduler_eligible, generation_state, priority,
    issue_created_at, linear_issue_identifier
  );

create index scheduler_slots_capacity_idx
  on momi_agent_ops.scheduler_slots (route_key, action_class, state)
  where state in ('reserved', 'running', 'quarantined');

alter table momi_agent_ops.scheduler_route_policies enable row level security;
alter table momi_agent_ops.scheduler_leaders enable row level security;
alter table momi_agent_ops.scheduler_candidates enable row level security;
alter table momi_agent_ops.scheduler_slots enable row level security;
revoke all on table momi_agent_ops.scheduler_route_policies,
  momi_agent_ops.scheduler_leaders,
  momi_agent_ops.scheduler_candidates,
  momi_agent_ops.scheduler_slots
  from public, anon, authenticated, service_role;

create function momi_agent_ops.acquire_scheduler_leader_v1(
  p_route_key text,
  p_owner_id uuid,
  p_release_sha text
) returns table (
  route_key text,
  fencing_generation bigint,
  lease_expires_at timestamptz
) language plpgsql security invoker set search_path = '' as $$
declare
  policy momi_agent_ops.scheduler_route_policies%rowtype;
  current_leader momi_agent_ops.scheduler_leaders%rowtype;
  next_generation bigint;
begin
  if p_route_key is null or p_owner_id is null or p_release_sha is null
    or p_release_sha !~ '^[0-9a-f]{40}$' then
    return;
  end if;
  select configured.* into policy
  from momi_agent_ops.scheduler_route_policies configured
  where configured.route_key = p_route_key
  for update;
  if not found or policy.mode = 'disabled'
    or (policy.mode = 'enabled' and policy.accepted_release_sha is distinct from p_release_sha)
    or policy.next_provider_attempt_at > now() then
    return;
  end if;

  select leader.* into current_leader
  from momi_agent_ops.scheduler_leaders leader
  where leader.route_key = p_route_key
  for update;
  if found and current_leader.owner_id <> p_owner_id
    and current_leader.lease_expires_at > now() then
    return;
  end if;

  next_generation := case
    when current_leader.route_key is null then 1
    when current_leader.owner_id = p_owner_id then current_leader.fencing_generation
    else current_leader.fencing_generation + 1
  end;
  insert into momi_agent_ops.scheduler_leaders as leader (
    route_key, owner_id, fencing_generation, lease_expires_at, heartbeat_at
  ) values (
    p_route_key, p_owner_id, next_generation, now() + interval '30 seconds', now()
  ) on conflict (route_key) do update set
    owner_id = excluded.owner_id,
    fencing_generation = excluded.fencing_generation,
    lease_expires_at = excluded.lease_expires_at,
    heartbeat_at = excluded.heartbeat_at,
    updated_at = now();

  return query select p_route_key, next_generation, now() + interval '30 seconds';
end;
$$;

create function momi_agent_ops.reconcile_scheduler_candidate_v1(
  p_route_key text,
  p_linear_project_id uuid,
  p_linear_issue_id uuid,
  p_linear_issue_identifier text,
  p_linear_issue_url text,
  p_issue_state text,
  p_priority integer,
  p_issue_created_at timestamptz,
  p_issue_updated_at timestamptz,
  p_labels text[],
  p_adapter_dispatchable boolean,
  p_dispatchability_reasons text[]
) returns table (
  candidate_id uuid,
  generation bigint,
  generation_state text,
  snapshot_version bigint,
  scheduler_eligible boolean
) language plpgsql security invoker set search_path = '' as $$
declare
  policy momi_agent_ops.scheduler_route_policies%rowtype;
  mapping momi_agent_ops.project_mappings%rowtype;
  current_candidate momi_agent_ops.scheduler_candidates%rowtype;
  eligible boolean;
  reason text;
  next_generation bigint;
  next_state text;
  next_snapshot bigint;
begin
  select configured.* into policy
  from momi_agent_ops.scheduler_route_policies configured
  where configured.route_key = p_route_key;
  select configured.* into mapping
  from momi_agent_ops.project_mappings configured
  where configured.linear_project_id = p_linear_project_id
    and configured.active
    and configured.repository = policy.repository
    and configured.base_branch = policy.base_branch
    and configured.host_dispatch_url = policy.host_dispatch_url;
  if policy.route_key is null or mapping.linear_project_id is null
    or p_linear_issue_id is null or p_linear_issue_identifier is null
    or p_issue_state is null or p_labels is null
    or p_adapter_dispatchable is null or p_dispatchability_reasons is null then
    raise exception 'scheduler_candidate_input_invalid' using errcode = '22023';
  end if;

  eligible := p_adapter_dispatchable
    and coalesce(p_linear_issue_url ~ '^https://linear\.app/', false)
    and exists (
      select 1 from unnest(mapping.active_states) active_state
      where lower(btrim(active_state)) = lower(btrim(p_issue_state))
    )
    and not exists (
      select 1 from unnest(policy.required_labels) required_label
      where not exists (
        select 1 from unnest(p_labels) issue_label
        where lower(btrim(issue_label)) = lower(btrim(required_label))
      )
    );
  reason := case
    when not p_adapter_dispatchable then coalesce(p_dispatchability_reasons[1], 'adapter_unroutable')
    when p_linear_issue_url is null or p_linear_issue_url !~ '^https://linear\.app/' then 'invalid_issue_url'
    when not exists (
      select 1 from unnest(mapping.active_states) active_state
      where lower(btrim(active_state)) = lower(btrim(p_issue_state))
    ) then 'inactive_state'
    when exists (
      select 1 from unnest(policy.required_labels) required_label
      where not exists (
        select 1 from unnest(p_labels) issue_label
        where lower(btrim(issue_label)) = lower(btrim(required_label))
      )
    ) then 'required_label_missing'
    else null
  end;

  select candidate.* into current_candidate
  from momi_agent_ops.scheduler_candidates candidate
  where candidate.linear_project_id = p_linear_project_id
    and candidate.linear_issue_id = p_linear_issue_id
  for update;
  if not found then
    next_generation := case when eligible then 1 else 0 end;
    next_state := case when eligible then 'eligible' else 'waiting' end;
    next_snapshot := 1;
    insert into momi_agent_ops.scheduler_candidates (
      linear_project_id, route_key, linear_issue_id, linear_issue_identifier,
      linear_issue_url, issue_state, priority, issue_created_at, issue_updated_at,
      labels, adapter_dispatchable, dispatchability_reasons, scheduler_eligible,
      waiting_reason, generation, generation_state, snapshot_version, last_eligible
    ) values (
      p_linear_project_id, p_route_key, p_linear_issue_id, p_linear_issue_identifier,
      p_linear_issue_url, p_issue_state, p_priority, p_issue_created_at, p_issue_updated_at,
      p_labels, p_adapter_dispatchable, p_dispatchability_reasons, eligible,
      reason, next_generation, next_state, next_snapshot, eligible
    ) returning scheduler_candidates.candidate_id into candidate_id;
  else
    next_generation := current_candidate.generation;
    next_state := current_candidate.generation_state;
    if not eligible then
      if current_candidate.generation_state = 'eligible' then next_state := 'stale'; end if;
      if current_candidate.generation_state = 'waiting' then next_state := 'waiting'; end if;
    elsif not current_candidate.last_eligible
      and current_candidate.generation_state not in ('claimed', 'running') then
      next_generation := current_candidate.generation + 1;
      next_state := 'eligible';
    end if;
    next_snapshot := current_candidate.snapshot_version + 1;
    update momi_agent_ops.scheduler_candidates candidate set
      route_key = p_route_key,
      linear_issue_identifier = p_linear_issue_identifier,
      linear_issue_url = p_linear_issue_url,
      issue_state = p_issue_state,
      priority = p_priority,
      issue_created_at = p_issue_created_at,
      issue_updated_at = p_issue_updated_at,
      labels = p_labels,
      adapter_dispatchable = p_adapter_dispatchable,
      dispatchability_reasons = p_dispatchability_reasons,
      scheduler_eligible = eligible,
      waiting_reason = reason,
      generation = next_generation,
      generation_state = next_state,
      snapshot_version = next_snapshot,
      last_eligible = eligible,
      last_reconciled_at = now(),
      updated_at = now()
    where candidate.candidate_id = current_candidate.candidate_id;
    candidate_id := current_candidate.candidate_id;
  end if;
  generation := next_generation;
  generation_state := next_state;
  snapshot_version := next_snapshot;
  scheduler_eligible := eligible;
  return next;
end;
$$;

create function momi_agent_ops.mark_scheduler_candidate_stale_v1(
  p_route_key text,
  p_linear_project_id uuid,
  p_linear_issue_id uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update momi_agent_ops.scheduler_candidates candidate set
    scheduler_eligible = false,
    waiting_reason = 'provider_record_missing',
    generation_state = case when candidate.generation_state = 'eligible'
      then 'stale' else candidate.generation_state end,
    last_eligible = false,
    snapshot_version = candidate.snapshot_version + 1,
    last_reconciled_at = now(),
    updated_at = now()
  where candidate.route_key = p_route_key
    and candidate.linear_project_id = p_linear_project_id
    and candidate.linear_issue_id = p_linear_issue_id
    and candidate.generation_state not in ('terminal');
  return found;
end;
$$;

create function momi_agent_ops.claim_scheduler_candidate_v1(
  p_route_key text,
  p_owner_id uuid,
  p_release_sha text,
  p_leader_generation bigint,
  p_candidate_id uuid,
  p_candidate_generation bigint,
  p_snapshot_version bigint
) returns table (claimed boolean, dispatch_id uuid) language plpgsql
security invoker set search_path = '' as $$
declare
  policy momi_agent_ops.scheduler_route_policies%rowtype;
  leader momi_agent_ops.scheduler_leaders%rowtype;
  candidate momi_agent_ops.scheduler_candidates%rowtype;
  mapping momi_agent_ops.project_mappings%rowtype;
  active_count integer;
  class_count integer;
  capability uuid;
  created_dispatch_id uuid;
begin
  select configured.* into policy
  from momi_agent_ops.scheduler_route_policies configured
  where configured.route_key = p_route_key
  for update;
  if not found or policy.mode <> 'enabled'
    or policy.accepted_release_sha is distinct from p_release_sha
    or policy.acceptance_completed_at is null then
    return query select false, null::uuid;
    return;
  end if;
  select current_leader.* into leader
  from momi_agent_ops.scheduler_leaders current_leader
  where current_leader.route_key = p_route_key
    and current_leader.owner_id = p_owner_id
    and current_leader.fencing_generation = p_leader_generation
    and current_leader.lease_expires_at > now();
  if not found then
    return query select false, null::uuid;
    return;
  end if;
  select queued.* into candidate
  from momi_agent_ops.scheduler_candidates queued
  where queued.candidate_id = p_candidate_id
    and queued.route_key = p_route_key
    and queued.generation = p_candidate_generation
    and queued.snapshot_version = p_snapshot_version
    and queued.generation_state = 'eligible'
    and queued.scheduler_eligible
    and queued.adapter_dispatchable
    and queued.last_reconciled_at >= now() - interval '30 seconds'
  for update;
  if not found then
    return query select false, null::uuid;
    return;
  end if;
  select configured.* into mapping
  from momi_agent_ops.project_mappings configured
  where configured.linear_project_id = candidate.linear_project_id
    and configured.active
    and configured.repository = policy.repository
    and configured.base_branch = policy.base_branch
    and configured.host_dispatch_url = policy.host_dispatch_url;
  if not found
    or not exists (
      select 1 from unnest(mapping.active_states) active_state
      where lower(btrim(active_state)) = lower(btrim(candidate.issue_state))
    )
    or exists (
      select 1 from unnest(policy.required_labels) required_label
      where not exists (
        select 1 from unnest(candidate.labels) issue_label
        where lower(btrim(issue_label)) = lower(btrim(required_label))
      )
    ) then
    return query select false, null::uuid;
    return;
  end if;
  select count(*) into active_count
  from momi_agent_ops.scheduler_slots slot
  where slot.route_key = p_route_key
    and slot.state in ('reserved', 'running', 'quarantined');
  select count(*) into class_count
  from momi_agent_ops.scheduler_slots slot
  where slot.route_key = p_route_key
    and slot.action_class = 'implementation'
    and slot.state in ('reserved', 'running', 'quarantined');
  if active_count >= policy.max_concurrent
    or class_count >= policy.implementation_limit then
    update momi_agent_ops.scheduler_candidates queued set
      waiting_reason = 'capacity_waiting', updated_at = now()
    where queued.candidate_id = candidate.candidate_id;
    return query select false, null::uuid;
    return;
  end if;

  capability := gen_random_uuid();
  insert into momi_agent_ops.dispatches (
    receipt_delivery_id, idempotency_key, linear_issue_id,
    linear_issue_identifier, linear_issue_url, linear_project_id,
    linear_project_name, action, changed_fields, mapped_repository,
    mapped_base_branch, active_states, capability_token_hash,
    wake_capability_token, source_kind, scheduler_candidate_id,
    scheduler_generation
  ) values (
    null,
    'scheduler:' || candidate.candidate_id::text || ':' || candidate.generation::text,
    candidate.linear_issue_id, candidate.linear_issue_identifier,
    candidate.linear_issue_url, candidate.linear_project_id,
    mapping.linear_project_name, 'exec' || 'ute-run',
    jsonb_build_object('scheduler', jsonb_build_object(
      'candidate_id', candidate.candidate_id::text,
      'generation', candidate.generation,
      'snapshot_version', candidate.snapshot_version
    )),
    mapping.repository, mapping.base_branch, mapping.active_states,
    encode(extensions.digest(convert_to(capability::text, 'UTF8'), 'sha256'), 'hex'),
    capability, 'ready_leaf_scheduler', candidate.candidate_id,
    candidate.generation
  ) returning dispatches.dispatch_id into created_dispatch_id;
  insert into momi_agent_ops.run_records (dispatch_id, readiness_result)
  values (created_dispatch_id, 'pending');
  insert into momi_agent_ops.scheduler_slots (
    route_key, action_class, candidate_id, candidate_generation,
    dispatch_id, leader_generation, state, lease_expires_at
  ) values (
    p_route_key, 'implementation', candidate.candidate_id,
    candidate.generation, created_dispatch_id, p_leader_generation,
    'reserved', now() + interval '30 seconds'
  );
  update momi_agent_ops.scheduler_candidates queued set
    generation_state = 'claimed', waiting_reason = null,
    updated_at = now()
  where queued.candidate_id = candidate.candidate_id;
  return query select true, created_dispatch_id;
end;
$$;

create function momi_agent_ops.reconcile_scheduler_dispatch_state_v1()
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
  elsif new.host_accepted_at is not null or new.work_status = 'active' then
    update momi_agent_ops.scheduler_slots slot set
      state = 'running', lease_expires_at = now() + interval '30 seconds',
      updated_at = now()
    where slot.dispatch_id = new.dispatch_id and slot.state <> 'released';
    update momi_agent_ops.scheduler_candidates candidate set
      generation_state = 'running',
      updated_at = now()
    where candidate.candidate_id = new.scheduler_candidate_id
      and candidate.generation = new.scheduler_generation;
  end if;
  return new;
end;
$$;

create trigger reconcile_ready_leaf_scheduler_dispatch
after update of work_status, host_accepted_at, completed_at
on momi_agent_ops.dispatches
for each row execute function momi_agent_ops.reconcile_scheduler_dispatch_state_v1();

create function momi_agent_ops.heartbeat_scheduler_slots_v1(
  p_active_work_ids uuid[]
) returns table (extended integer, released integer, quarantined integer)
language plpgsql security invoker set search_path = '' as $$
declare
  extended_count integer;
  released_count integer;
  quarantined_count integer;
begin
  if p_active_work_ids is null or cardinality(p_active_work_ids) > 128 then
    raise exception 'scheduler_heartbeat_invalid' using errcode = '22023';
  end if;
  update momi_agent_ops.scheduler_slots slot set
    lease_expires_at = now() + interval '30 seconds', updated_at = now()
  where slot.dispatch_id = any (p_active_work_ids)
    and slot.state in ('reserved', 'running', 'quarantined');
  get diagnostics extended_count = row_count;

  update momi_agent_ops.scheduler_slots slot set
    state = 'released', lease_expires_at = null,
    released_at = coalesce(slot.released_at, now()), updated_at = now()
  from momi_agent_ops.dispatches work
  where work.dispatch_id = slot.dispatch_id
    and work.work_status in ('completed', 'cancelled', 'rejected', 'dead_letter')
    and slot.state <> 'released';
  get diagnostics released_count = row_count;

  update momi_agent_ops.scheduler_slots slot set
    state = 'quarantined', updated_at = now()
  from momi_agent_ops.dispatches work
  where work.dispatch_id = slot.dispatch_id
    and slot.state in ('reserved', 'running')
    and slot.lease_expires_at <= now()
    and not (slot.dispatch_id = any (p_active_work_ids))
    and work.work_status not in ('completed', 'cancelled', 'rejected', 'dead_letter');
  get diagnostics quarantined_count = row_count;
  return query select extended_count, released_count, quarantined_count;
end;
$$;

create function momi_agent_ops.record_scheduler_provider_retry_v1(
  p_route_key text,
  p_error_code text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update momi_agent_ops.scheduler_route_policies policy set
    provider_retry_count = least(policy.provider_retry_count + 1, 1000000),
    next_provider_attempt_at = now() + make_interval(secs => least(300,
      5 * (2 ^ least(policy.provider_retry_count, 6))::integer)),
    last_provider_error_code = left(coalesce(nullif(p_error_code, ''),
      'tracker_request'), 120),
    updated_at = now()
  where policy.route_key = p_route_key and policy.mode <> 'disabled';
  return found;
end;
$$;

create function momi_agent_ops.record_scheduler_provider_success_v1(
  p_route_key text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update momi_agent_ops.scheduler_route_policies policy set
    provider_retry_count = 0, next_provider_attempt_at = now(),
    last_provider_error_code = null, updated_at = now()
  where policy.route_key = p_route_key;
  return found;
end;
$$;

revoke all on function momi_agent_ops.acquire_scheduler_leader_v1(text, uuid, text),
  momi_agent_ops.reconcile_scheduler_candidate_v1(
    text, uuid, uuid, text, text, text, integer, timestamptz, timestamptz,
    text[], boolean, text[]
  ),
  momi_agent_ops.mark_scheduler_candidate_stale_v1(text, uuid, uuid),
  momi_agent_ops.claim_scheduler_candidate_v1(text, uuid, text, bigint, uuid, bigint, bigint),
  momi_agent_ops.reconcile_scheduler_dispatch_state_v1(),
  momi_agent_ops.heartbeat_scheduler_slots_v1(uuid[]),
  momi_agent_ops.record_scheduler_provider_retry_v1(text, text),
  momi_agent_ops.record_scheduler_provider_success_v1(text)
  from public, anon, authenticated, service_role;
