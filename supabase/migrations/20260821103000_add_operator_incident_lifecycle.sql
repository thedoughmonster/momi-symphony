-- service-owner: agent-control

create table momi_agent_ops.operator_incidents (
  incident_id uuid primary key default gen_random_uuid(),
  incident_identity text not null unique check (incident_identity ~ '^[0-9a-f]{64}$'),
  implementation_dispatch_id uuid not null
    references momi_agent_ops.dispatches(dispatch_id),
  run_id uuid not null references momi_agent_ops.run_records(run_id),
  review_attempt_id uuid references momi_agent_ops.review_attempts(review_attempt_id),
  scheduler_slot_id uuid references momi_agent_ops.scheduler_slots(slot_id),
  generation_key text not null check (
    length(generation_key) between 1 and 160
    and generation_key ~ '^[A-Za-z0-9._:/-]+$'
  ),
  linear_issue_id uuid not null,
  linear_issue_identifier text not null check (
    length(linear_issue_identifier) between 1 and 80
  ),
  linear_issue_url text not null check (linear_issue_url ~ '^https://linear\.app/'),
  lifecycle_phase text not null check (lifecycle_phase in (
    'checking', 'working', 'validating', 'reviewing', 'releasing', 'callback',
    'scheduler', 'terminal'
  )),
  category text not null check (category in (
    'terminal_failure', 'run_ambiguous', 'reviewer_ambiguous',
    'callback_ambiguous', 'slot_ambiguous', 'retained_task_ambiguous'
  )),
  lifecycle_state text not null check (lifecycle_state in (
    'active', 'ambiguous', 'resolved', 'superseded'
  )),
  repository text check (
    repository is null or repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  ),
  base_branch text check (
    base_branch is null or base_branch ~ '^[A-Za-z0-9._/-]+$'
  ),
  pull_request_number bigint check (
    pull_request_number is null or pull_request_number > 0
  ),
  head_sha text check (head_sha is null or head_sha ~ '^[0-9a-f]{40}$'),
  dispatch_id uuid not null,
  review_generation_id uuid,
  first_observed_at timestamptz not null,
  last_progress_at timestamptz not null,
  guidance_code text not null check (guidance_code in (
    'inspect_terminal_failure', 'recover_dispatch', 'reconcile_reviewer_start',
    'retry_terminal_callback', 'reconcile_scheduler_slot',
    'reconcile_retained_task'
  )),
  resolution_code text check (resolution_code is null or resolution_code in (
    'automatic_recovery', 'canceled', 'completed', 'operator_recovered',
    'generation_superseded'
  )),
  resolved_at timestamptz,
  superseded_at timestamptz,
  observation_count integer not null default 1 check (
    observation_count between 1 and 1000000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (dispatch_id = implementation_dispatch_id),
  check (
    (category = 'reviewer_ambiguous' and review_attempt_id is not null
      and review_generation_id = review_attempt_id)
    or (category <> 'reviewer_ambiguous' and review_attempt_id is null
      and review_generation_id is null)
  ),
  check (
    (category = 'slot_ambiguous' and scheduler_slot_id is not null)
    or (category <> 'slot_ambiguous' and scheduler_slot_id is null)
  ),
  check (
    (lifecycle_state in ('active', 'ambiguous')
      and resolution_code is null and resolved_at is null and superseded_at is null)
    or (lifecycle_state = 'resolved' and resolution_code is not null
      and resolved_at is not null and superseded_at is null)
    or (lifecycle_state = 'superseded'
      and resolution_code = 'generation_superseded'
      and resolved_at is null and superseded_at is not null)
  )
);

create unique index operator_incidents_one_open_generation_idx
  on momi_agent_ops.operator_incidents (
    implementation_dispatch_id, category, generation_key
  ) where lifecycle_state in ('active', 'ambiguous');

create index operator_incidents_operator_queue_idx
  on momi_agent_ops.operator_incidents (
    lifecycle_state, first_observed_at, incident_id
  ) where lifecycle_state in ('active', 'ambiguous');

alter table momi_agent_ops.operator_incidents enable row level security;
revoke all on table momi_agent_ops.operator_incidents
  from public, anon, authenticated, service_role;

create function momi_agent_ops.record_operator_incident_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_category text,
  p_generation_key text, p_lifecycle_phase text, p_guidance_code text,
  p_review_attempt_id uuid default null, p_scheduler_slot_id uuid default null,
  p_observed_at timestamptz default now()
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  work momi_agent_ops.dispatches%rowtype;
  run momi_agent_ops.run_records%rowtype;
  review momi_agent_ops.review_attempts%rowtype;
  slot momi_agent_ops.scheduler_slots%rowtype;
  identity text;
  created_incident_id uuid;
  initial_state text;
  initial_resolution_code text;
  initial_superseded_at timestamptz;
  issue_id uuid;
begin
  if p_category not in ('terminal_failure', 'run_ambiguous', 'reviewer_ambiguous',
      'callback_ambiguous', 'slot_ambiguous', 'retained_task_ambiguous')
    or p_generation_key is null or length(p_generation_key) not between 1 and 160
    or p_generation_key !~ '^[A-Za-z0-9._:/-]+$'
    or p_lifecycle_phase not in ('checking', 'working', 'validating', 'reviewing',
      'releasing', 'callback', 'scheduler', 'terminal')
    or p_guidance_code not in ('inspect_terminal_failure', 'recover_dispatch',
      'reconcile_reviewer_start', 'retry_terminal_callback',
      'reconcile_scheduler_slot', 'reconcile_retained_task')
    or p_observed_at is null then
    raise exception 'operator_incident_invalid' using errcode = '22023';
  end if;
  if (p_category = 'terminal_failure') <> (p_guidance_code = 'inspect_terminal_failure')
    or (p_category = 'reviewer_ambiguous') <>
      (p_guidance_code = 'reconcile_reviewer_start')
    or (p_category = 'callback_ambiguous') <>
      (p_guidance_code = 'retry_terminal_callback')
    or (p_category = 'slot_ambiguous') <>
      (p_guidance_code = 'reconcile_scheduler_slot')
    or (p_category = 'retained_task_ambiguous') <>
      (p_guidance_code = 'reconcile_retained_task') then
    raise exception 'operator_incident_category_guidance_mismatch' using errcode = '22023';
  end if;
  select selected.linear_issue_id into issue_id
  from momi_agent_ops.dispatches selected
  where selected.dispatch_id = p_dispatch_id
    and selected.action = ('exec' || 'ute-run');
  if not found then return null; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || issue_id::text, 0));
  select selected.* into work from momi_agent_ops.dispatches selected
  where selected.dispatch_id = p_dispatch_id
    and selected.action = ('exec' || 'ute-run')
    and (encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex') in (
        selected.capability_token_hash, selected.host_callback_token_hash)
      or (p_category = 'reviewer_ambiguous' and p_review_attempt_id is not null
        and exists (select 1 from momi_agent_ops.review_attempts incident_review
          where incident_review.review_attempt_id = p_review_attempt_id
            and incident_review.implementation_dispatch_id = selected.dispatch_id
            and incident_review.reviewer_callback_capability_hash =
              encode(extensions.digest(convert_to(
                p_capability_token::text, 'UTF8'), 'sha256'), 'hex'))))
  for update;
  if not found then return null; end if;
  select selected.* into run from momi_agent_ops.run_records selected
  where selected.dispatch_id = p_dispatch_id for update;
  if not found then return null; end if;
  if p_category <> 'reviewer_ambiguous'
    and exists (select 1 from momi_agent_ops.dispatches newer
    where newer.linear_issue_id = work.linear_issue_id
      and newer.linear_project_id = work.linear_project_id
      and newer.action = ('exec' || 'ute-run')
      and newer.rejection_code is null
      and newer.mapped_repository = work.mapped_repository
      and newer.mapped_base_branch = work.mapped_base_branch
      and (newer.created_at, newer.dispatch_id) >
        (work.created_at, work.dispatch_id)) then
    initial_state := 'superseded';
    initial_resolution_code := 'generation_superseded';
    initial_superseded_at := p_observed_at;
  end if;
  if p_category = 'reviewer_ambiguous' then
    select selected.* into review from momi_agent_ops.review_attempts selected
    where selected.review_attempt_id = p_review_attempt_id
      and selected.implementation_dispatch_id = p_dispatch_id
      and selected.state = 'pending'
    for update;
    if not found or p_scheduler_slot_id is not null then return null; end if;
    select incident.incident_id into created_incident_id
    from momi_agent_ops.operator_incidents incident
    join momi_agent_ops.review_attempts incident_review
      on incident_review.review_attempt_id = incident.review_attempt_id
    where incident.implementation_dispatch_id = p_dispatch_id
      and incident.category = 'reviewer_ambiguous'
      and incident.lifecycle_state = 'ambiguous'
      and (incident_review.created_at, incident_review.review_attempt_id) >
        (review.created_at, review.review_attempt_id)
    order by incident_review.created_at desc,
      incident_review.review_attempt_id desc limit 1;
    if found then return created_incident_id; end if;
  elsif p_review_attempt_id is not null then return null;
  end if;
  if p_category = 'slot_ambiguous' then
    select selected.* into slot from momi_agent_ops.scheduler_slots selected
    where selected.slot_id = p_scheduler_slot_id
      and selected.dispatch_id = p_dispatch_id;
    if not found then return null; end if;
  elsif p_scheduler_slot_id is not null then return null;
  end if;
  identity := encode(extensions.digest(convert_to(
    p_dispatch_id::text || ':' || run.run_id::text || ':' || p_category || ':' ||
      p_generation_key, 'UTF8'), 'sha256'), 'hex');
  initial_state := coalesce(initial_state,
    case when p_category = 'terminal_failure' then 'active' else 'ambiguous' end);

  if initial_state <> 'superseded' then
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'superseded', resolution_code = 'generation_superseded',
      superseded_at = p_observed_at, updated_at = p_observed_at
    where incident.implementation_dispatch_id = p_dispatch_id
      and incident.category = p_category
      and incident.incident_identity <> identity
      and incident.lifecycle_state in ('active', 'ambiguous');
  end if;

  insert into momi_agent_ops.operator_incidents as incident (
    incident_identity, implementation_dispatch_id, run_id, review_attempt_id,
    scheduler_slot_id, generation_key, linear_issue_id, linear_issue_identifier,
    linear_issue_url, lifecycle_phase, category, lifecycle_state, repository,
    base_branch, pull_request_number, head_sha, dispatch_id, review_generation_id,
    first_observed_at, last_progress_at, guidance_code, resolution_code,
    superseded_at
  ) values (
    identity, p_dispatch_id, run.run_id, p_review_attempt_id, p_scheduler_slot_id,
    p_generation_key, work.linear_issue_id, work.linear_issue_identifier,
    work.linear_issue_url, p_lifecycle_phase, p_category, initial_state,
    work.mapped_repository, work.mapped_base_branch, run.pull_request_number,
    run.head_sha, p_dispatch_id, p_review_attempt_id, p_observed_at, p_observed_at,
    p_guidance_code, initial_resolution_code, initial_superseded_at
  ) on conflict (incident_identity) do update set
    last_progress_at = greatest(incident.last_progress_at, excluded.last_progress_at),
    observation_count = least(incident.observation_count + 1, 1000000),
    updated_at = greatest(incident.updated_at, excluded.updated_at)
  returning incident.incident_id into created_incident_id;
  return created_incident_id;
end;
$$;

create function momi_agent_ops.resolve_operator_incidents_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_resolution_code text,
  p_resolved_at timestamptz default now()
) returns integer language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if p_resolution_code not in (
      'automatic_recovery', 'canceled', 'completed', 'operator_recovered')
    or p_resolved_at is null then
    raise exception 'operator_incident_resolution_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from momi_agent_ops.dispatches work
    where work.dispatch_id = p_dispatch_id
      and encode(extensions.digest(
        convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex') in (
          work.capability_token_hash, work.host_callback_token_hash
        )) then return 0; end if;
  update momi_agent_ops.operator_incidents incident set
    lifecycle_state = 'resolved', resolution_code = p_resolution_code,
    resolved_at = p_resolved_at, updated_at = p_resolved_at
  where incident.implementation_dispatch_id = p_dispatch_id
    and incident.lifecycle_state in ('active', 'ambiguous');
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create function momi_agent_ops.record_terminal_v6(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_readiness_result text, p_terminal_disposition text,
  p_terminal_summary text, p_archived_at timestamptz, p_telemetry jsonb
) returns table (
  issue_id uuid, issue_identifier text, action text, linear_comment_id uuid
) language plpgsql security invoker set search_path = '' as $$
declare terminal record;
declare run momi_agent_ops.run_records%rowtype;
declare canceled boolean;
begin
  select callback.* into terminal from momi_agent_ops.record_terminal_v5(
    p_dispatch_id, p_capability_token, p_thread_id, p_turn_id,
    p_readiness_result, p_terminal_disposition, p_terminal_summary,
    p_archived_at, p_telemetry
  ) callback;
  if not found then return; end if;
  select current_run.* into run from momi_agent_ops.run_records current_run
  where current_run.dispatch_id = p_dispatch_id;
  select work.cancellation_requested_at is not null or work.cancelled_at is not null
  into canceled from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id;
  if terminal.action = ('exec' || 'ute-run') and not coalesce(canceled, false)
    and run.terminal_disposition in ('failed', 'interrupted') then
    perform momi_agent_ops.record_operator_incident_v1(
      p_dispatch_id, p_capability_token, 'terminal_failure',
      'run:' || run.run_id::text, 'terminal', 'inspect_terminal_failure',
      null, null, run.terminal_at
    );
  elsif terminal.action = ('exec' || 'ute-run') and not coalesce(canceled, false)
    and run.readiness_result = 'unready'
    and run.terminal_disposition = 'completed' then
    perform momi_agent_ops.record_operator_incident_v1(
      p_dispatch_id, p_capability_token, 'retained_task_ambiguous',
      'run:' || run.run_id::text, 'terminal', 'reconcile_retained_task',
      null, null, run.terminal_at
    );
  end if;
  return query select terminal.issue_id, terminal.issue_identifier,
    terminal.action, terminal.linear_comment_id;
end;
$$;

create function momi_agent_ops.record_linear_writeback_v6(
  p_dispatch_id uuid, p_capability_token uuid, p_comment_id uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare recorded boolean;
declare run momi_agent_ops.run_records%rowtype;
declare work momi_agent_ops.dispatches%rowtype;
begin
  select selected.* into work from momi_agent_ops.dispatches selected
  where selected.dispatch_id = p_dispatch_id
    and encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex') in (
        selected.capability_token_hash, selected.host_callback_token_hash)
  for update;
  if not found then return false; end if;
  select momi_agent_ops.record_linear_writeback_v5(
    p_dispatch_id, p_capability_token, p_comment_id
  ) into recorded;
  if not coalesce(recorded, false) then return false; end if;
  select selected.* into run from momi_agent_ops.run_records selected
  where selected.dispatch_id = p_dispatch_id for update;
  if work.action = ('exec' || 'ute-run')
    and (work.cancellation_requested_at is not null or work.cancelled_at is not null
      or (run.readiness_result = 'ready'
        and run.terminal_disposition = 'completed')) then
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'resolved',
      resolution_code = case when work.cancellation_requested_at is not null
        or work.cancelled_at is not null then 'canceled' else 'completed' end,
      resolved_at = coalesce(run.linear_writeback_at, now()),
      updated_at = coalesce(run.linear_writeback_at, now())
    where incident.implementation_dispatch_id = p_dispatch_id
      and incident.lifecycle_state in ('active', 'ambiguous');
  end if;
  return true;
end;
$$;

create function momi_agent_ops.reconcile_dispatch_operator_incident_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare run momi_agent_ops.run_records%rowtype;
declare incident_category text;
declare phase text;
declare guidance text;
declare generation text;
declare identity text;
declare initial_state text := 'ambiguous';
declare initial_resolution_code text;
declare initial_superseded_at timestamptz;
begin
  if new.action <> ('exec' || 'ute-run') then return new; end if;
  select current_run.* into run from momi_agent_ops.run_records current_run
  where current_run.dispatch_id = new.dispatch_id;
  if not found then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || new.linear_issue_id::text, 0));
  if old.work_status = 'dead_letter' and new.work_status = 'pending' then
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'resolved', resolution_code = 'operator_recovered',
      resolved_at = now(), updated_at = now()
    where incident.implementation_dispatch_id = new.dispatch_id
      and incident.lifecycle_state in ('active', 'ambiguous');
    return new;
  end if;
  if new.work_status in ('cancelled') and old.work_status is distinct from new.work_status then
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'resolved', resolution_code = 'canceled',
      resolved_at = now(), updated_at = now()
    where incident.implementation_dispatch_id = new.dispatch_id
      and incident.lifecycle_state in ('active', 'ambiguous');
    return new;
  end if;
  if new.work_status <> 'dead_letter' or old.work_status = 'dead_letter' then return new; end if;
  incident_category := case
    when new.source_kind = 'ready_leaf_scheduler' then 'retained_task_ambiguous'
    when run.terminal_at is null and (new.dead_letter_recovered_at is not null
      or new.host_accepted_at is not null
      or new.codex_thread_id is not null or new.codex_turn_id is not null
      or new.host_callback_token_hash is not null) then 'retained_task_ambiguous'
    when run.terminal_at is null then 'run_ambiguous'
    else 'callback_ambiguous' end;
  phase := case
    when new.source_kind = 'ready_leaf_scheduler' then 'scheduler'
    when run.terminal_at is null then 'working'
    else 'callback' end;
  guidance := case
    when new.source_kind = 'ready_leaf_scheduler' then 'reconcile_retained_task'
    when run.terminal_at is null and (new.dead_letter_recovered_at is not null
      or new.host_accepted_at is not null
      or new.codex_thread_id is not null or new.codex_turn_id is not null
      or new.host_callback_token_hash is not null) then 'reconcile_retained_task'
    when run.terminal_at is null then 'recover_dispatch'
    else 'retry_terminal_callback' end;
  generation := 'dead-letter:' || new.attempt_count::text || ':' || coalesce(
    ((extract(epoch from new.dead_letter_recovered_at) * 1000000)::bigint)::text,
    'initial');
  identity := encode(extensions.digest(convert_to(
    new.dispatch_id::text || ':' || run.run_id::text || ':' || incident_category || ':' ||
      generation, 'UTF8'), 'sha256'), 'hex');
  if exists (select 1 from momi_agent_ops.dispatches newer
    join momi_agent_ops.project_mappings mapping
      on mapping.linear_project_id = newer.linear_project_id
      and mapping.active and mapping.repository = newer.mapped_repository
      and mapping.base_branch = newer.mapped_base_branch
    where newer.linear_issue_id = new.linear_issue_id
      and newer.linear_project_id = new.linear_project_id
      and newer.action = ('exec' || 'ute-run')
      and newer.rejection_code is null
      and newer.mapped_repository = new.mapped_repository
      and newer.mapped_base_branch = new.mapped_base_branch
      and (newer.created_at, newer.dispatch_id) >
        (new.created_at, new.dispatch_id)) then
    initial_state := 'superseded';
    initial_resolution_code := 'generation_superseded';
    initial_superseded_at := now();
  else
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'superseded', resolution_code = 'generation_superseded',
      superseded_at = now(), updated_at = now()
    where incident.implementation_dispatch_id = new.dispatch_id
      and incident.category = incident_category
      and incident.incident_identity <> identity
      and incident.lifecycle_state in ('active', 'ambiguous');
  end if;
  insert into momi_agent_ops.operator_incidents as incident (
    incident_identity, implementation_dispatch_id, run_id, generation_key,
    linear_issue_id, linear_issue_identifier, linear_issue_url, lifecycle_phase,
    category, lifecycle_state, repository, base_branch, pull_request_number,
    head_sha, dispatch_id, first_observed_at, last_progress_at, guidance_code,
    resolution_code, superseded_at
  ) values (
    identity, new.dispatch_id, run.run_id, generation, new.linear_issue_id,
    new.linear_issue_identifier, new.linear_issue_url, phase, incident_category, initial_state,
    new.mapped_repository, new.mapped_base_branch, run.pull_request_number,
    run.head_sha, new.dispatch_id, now(), now(), guidance,
    initial_resolution_code, initial_superseded_at
  ) on conflict (incident_identity) do update set
    last_progress_at = greatest(incident.last_progress_at, excluded.last_progress_at),
    observation_count = least(incident.observation_count + 1, 1000000),
    updated_at = greatest(incident.updated_at, excluded.updated_at);
  return new;
end;
$$;

create trigger reconcile_dispatch_operator_incident_v1
after update of work_status on momi_agent_ops.dispatches
for each row execute function momi_agent_ops.reconcile_dispatch_operator_incident_v1();

create function momi_agent_ops.reconcile_slot_operator_incident_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare work momi_agent_ops.dispatches%rowtype;
declare run momi_agent_ops.run_records%rowtype;
declare generation text;
declare identity text;
declare initial_state text := 'ambiguous';
declare initial_resolution_code text;
declare initial_superseded_at timestamptz;
begin
  if new.state = 'released' and old.state is distinct from new.state then
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'resolved', resolution_code = 'automatic_recovery',
      resolved_at = now(), updated_at = now()
    where incident.scheduler_slot_id = new.slot_id
      and incident.lifecycle_state in ('active', 'ambiguous');
    return new;
  end if;
  if new.state <> 'quarantined' or old.state = 'quarantined' then return new; end if;
  select selected.* into work from momi_agent_ops.dispatches selected
  where selected.dispatch_id = new.dispatch_id
    and selected.action = ('exec' || 'ute-run');
  if not found then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || work.linear_issue_id::text, 0));
  select selected.* into run from momi_agent_ops.run_records selected
  where selected.dispatch_id = new.dispatch_id;
  if not found then return new; end if;
  generation := 'slot:' || new.slot_id::text || ':' || new.leader_generation::text;
  identity := encode(extensions.digest(convert_to(
    new.dispatch_id::text || ':' || run.run_id::text || ':slot_ambiguous:' ||
      generation, 'UTF8'), 'sha256'), 'hex');
  if exists (select 1 from momi_agent_ops.dispatches newer
    join momi_agent_ops.project_mappings mapping
      on mapping.linear_project_id = newer.linear_project_id
      and mapping.active and mapping.repository = newer.mapped_repository
      and mapping.base_branch = newer.mapped_base_branch
    where newer.linear_issue_id = work.linear_issue_id
      and newer.linear_project_id = work.linear_project_id
      and newer.action = ('exec' || 'ute-run')
      and newer.rejection_code is null
      and newer.mapped_repository = work.mapped_repository
      and newer.mapped_base_branch = work.mapped_base_branch
      and (newer.created_at, newer.dispatch_id) >
        (work.created_at, work.dispatch_id)) then
    initial_state := 'superseded';
    initial_resolution_code := 'generation_superseded';
    initial_superseded_at := now();
  else
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'superseded', resolution_code = 'generation_superseded',
      superseded_at = now(), updated_at = now()
    where incident.implementation_dispatch_id = new.dispatch_id
      and incident.category = 'slot_ambiguous'
      and incident.incident_identity <> identity
      and incident.lifecycle_state in ('active', 'ambiguous');
  end if;
  insert into momi_agent_ops.operator_incidents as incident (
    incident_identity, implementation_dispatch_id, run_id, scheduler_slot_id,
    generation_key, linear_issue_id, linear_issue_identifier, linear_issue_url,
    lifecycle_phase, category, lifecycle_state, repository, base_branch,
    pull_request_number, head_sha, dispatch_id, first_observed_at,
    last_progress_at, guidance_code, resolution_code, superseded_at
  ) values (
    identity, new.dispatch_id, run.run_id, new.slot_id, generation,
    work.linear_issue_id, work.linear_issue_identifier, work.linear_issue_url,
    'scheduler', 'slot_ambiguous', initial_state, work.mapped_repository,
    work.mapped_base_branch, run.pull_request_number, run.head_sha,
    new.dispatch_id, now(), now(), 'reconcile_scheduler_slot',
    initial_resolution_code, initial_superseded_at
  ) on conflict (incident_identity) do update set
    last_progress_at = greatest(incident.last_progress_at, excluded.last_progress_at),
    observation_count = least(incident.observation_count + 1, 1000000),
    updated_at = greatest(incident.updated_at, excluded.updated_at);
  return new;
end;
$$;

create trigger reconcile_slot_operator_incident_v1
after update of state on momi_agent_ops.scheduler_slots
for each row execute function momi_agent_ops.reconcile_slot_operator_incident_v1();

create function momi_agent_ops.resolve_review_operator_incident_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.state = 'pending' and new.state <> 'pending' then
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'resolved', resolution_code = 'automatic_recovery',
      resolved_at = now(), updated_at = now()
    where incident.review_attempt_id = new.review_attempt_id
      and incident.lifecycle_state in ('active', 'ambiguous');
  end if;
  return new;
end;
$$;

create trigger resolve_review_operator_incident_v1
after update of state on momi_agent_ops.review_attempts
for each row execute function momi_agent_ops.resolve_review_operator_incident_v1();

create function momi_agent_ops.supersede_operator_incidents_for_new_dispatch_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.action = ('exec' || 'ute-run') and new.rejection_code is null
    and new.linear_project_id is not null
    and new.mapped_repository is not null and new.mapped_base_branch is not null
    and exists (select 1 from momi_agent_ops.project_mappings mapping
      where mapping.linear_project_id = new.linear_project_id and mapping.active
        and mapping.repository = new.mapped_repository
        and mapping.base_branch = new.mapped_base_branch) then
    update momi_agent_ops.operator_incidents incident set
      lifecycle_state = 'superseded', resolution_code = 'generation_superseded',
      superseded_at = now(), updated_at = now()
    from momi_agent_ops.dispatches prior
    where prior.dispatch_id = incident.implementation_dispatch_id
      and prior.linear_issue_id = new.linear_issue_id
      and prior.linear_project_id = new.linear_project_id
      and prior.mapped_repository = new.mapped_repository
      and prior.mapped_base_branch = new.mapped_base_branch
      and prior.dispatch_id <> new.dispatch_id
      and not (incident.category = 'reviewer_ambiguous'
        and exists (select 1 from momi_agent_ops.review_attempts pending_review
          where pending_review.review_attempt_id = incident.review_attempt_id
            and pending_review.state = 'pending'))
      and incident.lifecycle_state in ('active', 'ambiguous');
  end if;
  return new;
end;
$$;

create trigger supersede_operator_incidents_for_new_dispatch_v1
after insert on momi_agent_ops.dispatches
for each row execute function
  momi_agent_ops.supersede_operator_incidents_for_new_dispatch_v1();

grant all on function momi_agent_ops.record_operator_incident_v1(
  uuid, uuid, text, text, text, text, uuid, uuid, timestamptz
), momi_agent_ops.resolve_operator_incidents_v1(uuid, uuid, text, timestamptz),
  momi_agent_ops.record_linear_writeback_v6(uuid, uuid, uuid),
  momi_agent_ops.record_terminal_v6(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb
  ) to service_role;

revoke all on function momi_agent_ops.record_operator_incident_v1(
  uuid, uuid, text, text, text, text, uuid, uuid, timestamptz
), momi_agent_ops.resolve_operator_incidents_v1(uuid, uuid, text, timestamptz),
  momi_agent_ops.record_linear_writeback_v6(uuid, uuid, uuid),
  momi_agent_ops.record_terminal_v6(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb
  ), momi_agent_ops.reconcile_dispatch_operator_incident_v1(),
  momi_agent_ops.reconcile_slot_operator_incident_v1(),
  momi_agent_ops.resolve_review_operator_incident_v1(),
  momi_agent_ops.supersede_operator_incidents_for_new_dispatch_v1()
  from public, anon, authenticated, service_role;
