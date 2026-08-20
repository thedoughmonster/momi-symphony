-- service-owner: agent-control

alter table momi_agent_ops.run_records
  add column lifecycle_version text not null default 'agent-state-v1' check (
    lifecycle_version = 'agent-state-v1'
  ),
  add column branch_name text check (
    branch_name is null or branch_name ~ '^[A-Za-z0-9._/-]+$'
  ),
  add column pull_request_number bigint check (
    pull_request_number is null or pull_request_number > 0
  ),
  add column head_sha text check (head_sha is null or head_sha ~ '^[0-9a-f]{40}$'),
  add column merge_sha text check (merge_sha is null or merge_sha ~ '^[0-9a-f]{40}$'),
  add column validation_state text not null default 'not_required' check (
    validation_state in ('not_required', 'pending', 'running', 'succeeded', 'failed')
  ),
  add column validation_sha text check (
    validation_sha is null or validation_sha ~ '^[0-9a-f]{40}$'
  ),
  add column validation_workflow_run_id text check (
    validation_workflow_run_id is null or length(validation_workflow_run_id) between 1 and 160
  ),
  add column review_state text not null default 'not_required' check (
    review_state in ('not_required', 'pending', 'running', 'succeeded', 'failed')
  ),
  add column review_sha text check (review_sha is null or review_sha ~ '^[0-9a-f]{40}$'),
  add column review_workflow_run_id text check (
    review_workflow_run_id is null or length(review_workflow_run_id) between 1 and 160
  ),
  add column release_state text not null default 'not_required' check (
    release_state in ('not_required', 'pending', 'running', 'succeeded', 'failed')
  ),
  add column release_sha text check (release_sha is null or release_sha ~ '^[0-9a-f]{40}$'),
  add column release_workflow_run_id text check (
    release_workflow_run_id is null or length(release_workflow_run_id) between 1 and 160
  ),
  add column projected_agent_state text check (projected_agent_state is null or
    projected_agent_state in ('queued', 'checking', 'working', 'validating', 'reviewing',
      'releasing', 'waiting', 'failed', 'stopped', 'complete', 'coordinating')
  ),
  add column projected_agent_state_label_id uuid,
  add column agent_state_projected_at timestamptz,
  add constraint run_records_exact_validation check (
    validation_state = 'not_required' or (head_sha is not null and validation_sha = head_sha)
  ),
  add constraint run_records_exact_review check (
    review_state = 'not_required' or (head_sha is not null and review_sha = head_sha)
  ),
  add constraint run_records_exact_release check (
    release_state = 'not_required' or (merge_sha is not null and release_sha = merge_sha)
  );

create function momi_agent_ops.record_lifecycle_evidence_v1(
  p_dispatch_id uuid,
  p_capability_token uuid,
  p_thread_id text,
  p_turn_id text,
  p_repository text,
  p_base_branch text,
  p_branch_name text,
  p_pull_request_number bigint,
  p_phase text,
  p_status text,
  p_revision_sha text,
  p_merge_sha text,
  p_workflow_run_id text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  selected momi_agent_ops.dispatches%rowtype;
  current_dispatch_id uuid;
  current_run momi_agent_ops.run_records%rowtype;
  prior_state text;
begin
  if p_phase is null or p_phase not in ('validating', 'reviewing', 'releasing')
    or p_status is null or p_status not in ('pending', 'running', 'succeeded', 'failed')
    or p_repository is null or p_repository !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    or p_base_branch is null or p_base_branch !~ '^[A-Za-z0-9._/-]+$'
    or p_branch_name is null or p_branch_name !~ '^[A-Za-z0-9._/-]+$'
    or p_pull_request_number is null or p_pull_request_number < 1
    or p_revision_sha is null or p_revision_sha !~ '^[0-9a-f]{40}$'
    or (p_merge_sha is not null and p_merge_sha !~ '^[0-9a-f]{40}$')
    or (p_workflow_run_id is not null and length(p_workflow_run_id) not between 1 and 160)
    or (p_phase = 'releasing' and p_merge_sha is distinct from p_revision_sha) then
    raise exception 'lifecycle_evidence_invalid' using errcode = '22023';
  end if;
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
    and work.mapped_repository = p_repository and work.mapped_base_branch = p_base_branch
    and work.action not in ('cancel-run', 'recover-discovery')
  for update;
  if not found then return false; end if;
  select newest.dispatch_id into current_dispatch_id
  from momi_agent_ops.dispatches newest
  where newest.linear_issue_id = selected.linear_issue_id
    and newest.action not in ('cancel-run', 'recover-discovery')
  order by newest.created_at desc, newest.dispatch_id desc limit 1;
  if current_dispatch_id is distinct from selected.dispatch_id then return false; end if;
  select run.* into current_run from momi_agent_ops.run_records run
  where run.dispatch_id = selected.dispatch_id for update;
  if current_run.branch_name is distinct from p_branch_name
    and current_run.branch_name is not null then return false; end if;
  if current_run.pull_request_number is distinct from p_pull_request_number
    and current_run.pull_request_number is not null then return false; end if;
  if p_phase in ('validating', 'reviewing') and current_run.head_sha is distinct from p_revision_sha
    and current_run.head_sha is not null then return false; end if;
  if p_phase = 'releasing' and current_run.merge_sha is distinct from p_merge_sha
    and current_run.merge_sha is not null then return false; end if;
  prior_state := case p_phase
    when 'validating' then current_run.validation_state
    when 'reviewing' then current_run.review_state
    else current_run.release_state end;
  if prior_state in ('succeeded', 'failed') and prior_state <> p_status then return false; end if;
  if prior_state = 'running' and p_status = 'pending' then return false; end if;
  if p_workflow_run_id is not null and (case p_phase
      when 'validating' then current_run.validation_workflow_run_id
      when 'reviewing' then current_run.review_workflow_run_id
      else current_run.release_workflow_run_id end) is not null
    and p_workflow_run_id is distinct from (case p_phase
      when 'validating' then current_run.validation_workflow_run_id
      when 'reviewing' then current_run.review_workflow_run_id
      else current_run.release_workflow_run_id end) then return false; end if;

  update momi_agent_ops.run_records run set
    branch_name = coalesce(run.branch_name, p_branch_name),
    pull_request_number = coalesce(run.pull_request_number, p_pull_request_number),
    head_sha = case when p_phase in ('validating', 'reviewing')
      then coalesce(run.head_sha, p_revision_sha) else run.head_sha end,
    merge_sha = case when p_phase = 'releasing'
      then coalesce(run.merge_sha, p_merge_sha) else run.merge_sha end,
    validation_state = case when p_phase = 'validating' then p_status else run.validation_state end,
    validation_sha = case when p_phase = 'validating' then p_revision_sha else run.validation_sha end,
    validation_workflow_run_id = case when p_phase = 'validating'
      then coalesce(run.validation_workflow_run_id, p_workflow_run_id)
      else run.validation_workflow_run_id end,
    review_state = case when p_phase = 'reviewing' then p_status else run.review_state end,
    review_sha = case when p_phase = 'reviewing' then p_revision_sha else run.review_sha end,
    review_workflow_run_id = case when p_phase = 'reviewing'
      then coalesce(run.review_workflow_run_id, p_workflow_run_id)
      else run.review_workflow_run_id end,
    release_state = case when p_phase = 'releasing' then p_status else run.release_state end,
    release_sha = case when p_phase = 'releasing' then p_revision_sha else run.release_sha end,
    release_workflow_run_id = case when p_phase = 'releasing'
      then coalesce(run.release_workflow_run_id, p_workflow_run_id)
      else run.release_workflow_run_id end,
    updated_at = now()
  where run.dispatch_id = selected.dispatch_id;
  return found;
end;
$$;

create function momi_agent_ops.record_agent_state_projection_v1(
  p_dispatch_id uuid,
  p_agent_state text,
  p_label_id uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  issue_id uuid;
  current_dispatch_id uuid;
begin
  if p_agent_state is null or p_agent_state not in ('queued', 'checking', 'working', 'validating', 'reviewing',
    'releasing', 'waiting', 'failed', 'stopped', 'complete', 'coordinating')
    or p_label_id is null then
    raise exception 'agent_state_projection_invalid' using errcode = '22023';
  end if;
  select work.linear_issue_id into issue_id from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.action not in ('cancel-run', 'recover-discovery');
  if not found then return false; end if;
  select newest.dispatch_id into current_dispatch_id
  from momi_agent_ops.dispatches newest
  where newest.linear_issue_id = issue_id
    and newest.action not in ('cancel-run', 'recover-discovery')
  order by newest.created_at desc, newest.dispatch_id desc limit 1;
  if current_dispatch_id is distinct from p_dispatch_id then return false; end if;
  update momi_agent_ops.run_records run set
    projected_agent_state = p_agent_state,
    projected_agent_state_label_id = p_label_id,
    agent_state_projected_at = now(), updated_at = now()
  where run.dispatch_id = p_dispatch_id;
  return found;
end;
$$;

revoke all on function momi_agent_ops.record_lifecycle_evidence_v1(
  uuid, uuid, text, text, text, text, text, bigint, text, text, text, text, text
), momi_agent_ops.record_agent_state_projection_v1(uuid, text, uuid)
  from public, anon, authenticated, service_role;
