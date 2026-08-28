-- service-owner: agent-control

alter table momi_agent_ops.scheduler_route_policies
  alter column required_labels set default array['ready-package']::text[];

update momi_agent_ops.scheduler_route_policies
set required_labels = array['ready-package']::text[], updated_at = now()
where required_labels is distinct from array['ready-package']::text[];

alter table momi_agent_ops.run_records
  drop constraint run_records_lifecycle_version_check;
update momi_agent_ops.run_records set lifecycle_version = 'agent-state-v2';
alter table momi_agent_ops.run_records
  alter column lifecycle_version set default 'agent-state-v2',
  add constraint run_records_lifecycle_version_check check (
    lifecycle_version = 'agent-state-v2'
  );

alter table momi_agent_ops.run_records
  add column execution_status text check (
    execution_status in ('pending', 'running', 'succeeded', 'failed', 'interrupted')
  ),
  add column linear_projection_status text check (
    linear_projection_status in (
      'pending', 'in_progress', 'retryable', 'failed', 'succeeded', 'superseded'
    )
  ),
  add column linear_projection_attempt_count integer not null default 0 check (
    linear_projection_attempt_count between 0 and 1000000
  ),
  add column linear_projection_next_attempt_at timestamptz not null default now(),
  add column linear_projection_lease_expires_at timestamptz,
  add column linear_projection_last_attempt_at timestamptz,
  add column linear_projection_last_error_code text check (
    linear_projection_last_error_code is null
      or length(linear_projection_last_error_code) between 1 and 120
  ),
  add column linear_projection_completed_at timestamptz;

update momi_agent_ops.run_records run
set execution_status = case run.terminal_disposition
    when 'completed' then 'succeeded'
    when 'failed' then 'failed'
    when 'interrupted' then 'interrupted'
    else case when work.host_accepted_at is null then 'pending' else 'running' end
  end,
  linear_projection_status = case
    when run.linear_writeback_at is not null then 'succeeded'
    when run.terminal_at is not null then 'retryable'
    else 'pending'
  end,
  linear_projection_completed_at = case
    when run.linear_writeback_at is not null then run.linear_writeback_at
    else null
  end
from momi_agent_ops.dispatches work
where work.dispatch_id = run.dispatch_id;

alter table momi_agent_ops.run_records
  alter column execution_status set not null,
  alter column execution_status set default 'pending',
  alter column linear_projection_status set not null,
  alter column linear_projection_status set default 'pending',
  add constraint run_records_projection_success_receipt check (
    linear_projection_status <> 'succeeded' or linear_writeback_at is not null
  );

create index run_records_linear_projection_due_idx
  on momi_agent_ops.run_records (
    linear_projection_next_attempt_at, linear_projection_attempt_count, dispatch_id
  ) where linear_projection_status in ('pending', 'retryable', 'in_progress');

create function momi_agent_ops.record_terminal_v6(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_readiness_result text, p_terminal_disposition text,
  p_terminal_summary text, p_archived_at timestamptz, p_telemetry jsonb
) returns table (
  issue_id uuid, issue_identifier text, action text, linear_comment_id uuid
) language plpgsql security invoker set search_path = '' as $$
declare terminal record;
begin
  select prior.* into terminal from momi_agent_ops.record_terminal_v5(
    p_dispatch_id, p_capability_token, p_thread_id, p_turn_id,
    p_readiness_result, p_terminal_disposition, p_terminal_summary,
    p_archived_at, p_telemetry
  ) prior;
  if not found then return; end if;
  update momi_agent_ops.run_records run set
    execution_status = case run.terminal_disposition
      when 'completed' then 'succeeded'
      when 'failed' then 'failed'
      else 'interrupted' end,
    linear_projection_status = case
      when run.linear_projection_status = 'succeeded' then 'succeeded'
      when run.linear_projection_status = 'in_progress'
        and run.linear_projection_lease_expires_at > now() then 'in_progress'
      else 'pending' end,
    linear_projection_next_attempt_at = case
      when run.linear_projection_status = 'succeeded'
        then run.linear_projection_next_attempt_at
      else now() end,
    updated_at = now()
  where run.dispatch_id = p_dispatch_id;
  return query select terminal.issue_id, terminal.issue_identifier,
    terminal.action, terminal.linear_comment_id;
end;
$$;

create function momi_agent_ops.claim_terminal_projection_v1(
  p_dispatch_id uuid
) returns table (
  dispatch_id uuid, issue_id uuid, issue_identifier text, action text,
  thread_id text, turn_id text, linear_comment_id uuid,
  readiness_result text, terminal_disposition text,
  terminal_summary text, archived_at timestamptz
) language plpgsql security invoker set search_path = '' as $$
declare selected_work momi_agent_ops.dispatches%rowtype;
declare selected_run momi_agent_ops.run_records%rowtype;
declare current_dispatch_id uuid;
begin
  select work.* into selected_work from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id for update;
  if not found then return; end if;
  select run.* into selected_run from momi_agent_ops.run_records run
  where run.dispatch_id = p_dispatch_id for update;
  if not found or selected_run.terminal_at is null
    or selected_run.linear_projection_status in ('succeeded', 'superseded', 'failed')
    or selected_run.linear_projection_next_attempt_at > now()
    or (selected_run.linear_projection_status = 'in_progress'
      and selected_run.linear_projection_lease_expires_at > now()) then return; end if;

  if selected_work.action not in ('cancel-run', 'recover-discovery') then
    select newest.dispatch_id into current_dispatch_id
    from momi_agent_ops.dispatches newest
    where newest.linear_issue_id = selected_work.linear_issue_id
      and newest.action not in ('cancel-run', 'recover-discovery')
    order by newest.created_at desc, newest.dispatch_id desc limit 1;
    if current_dispatch_id is distinct from p_dispatch_id then
      update momi_agent_ops.run_records run set
        linear_projection_status = 'superseded',
        linear_projection_lease_expires_at = null,
        linear_projection_last_error_code = null,
        updated_at = now()
      where run.dispatch_id = p_dispatch_id;
      return;
    end if;
  end if;

  update momi_agent_ops.run_records run set
    linear_projection_status = 'in_progress',
    linear_projection_attempt_count = run.linear_projection_attempt_count + 1,
    linear_projection_last_attempt_at = now(),
    linear_projection_lease_expires_at = now() + interval '30 seconds',
    linear_projection_last_error_code = null,
    updated_at = now()
  where run.dispatch_id = p_dispatch_id;

  return query select selected_work.dispatch_id, selected_work.linear_issue_id,
    selected_work.linear_issue_identifier, selected_work.action,
    selected_work.codex_thread_id, selected_work.codex_turn_id,
    selected_run.linear_comment_id, selected_run.readiness_result,
    selected_run.terminal_disposition, coalesce(selected_run.terminal_summary, ''),
    selected_run.archived_at;
end;
$$;

create function momi_agent_ops.record_terminal_projection_result_v1(
  p_dispatch_id uuid, p_succeeded boolean, p_comment_id uuid, p_error_code text
) returns text language plpgsql security invoker set search_path = '' as $$
declare selected momi_agent_ops.run_records%rowtype;
declare next_status text;
begin
  if p_succeeded is null
    or (p_succeeded and (p_comment_id is null or p_error_code is not null))
    or (not p_succeeded and (p_comment_id is not null or p_error_code is null
      or length(p_error_code) not between 1 and 120)) then
    raise exception 'terminal_projection_result_invalid' using errcode = '22023';
  end if;
  select run.* into selected from momi_agent_ops.run_records run
  where run.dispatch_id = p_dispatch_id for update;
  if not found or selected.linear_projection_status <> 'in_progress' then return null; end if;
  next_status := case when p_succeeded then 'succeeded'
    when selected.linear_projection_attempt_count >= 8 then 'failed'
    else 'retryable' end;
  update momi_agent_ops.run_records run set
    linear_comment_id = case when p_succeeded then p_comment_id else run.linear_comment_id end,
    linear_writeback_at = case when p_succeeded
      then coalesce(run.linear_writeback_at, now()) else run.linear_writeback_at end,
    linear_projection_status = next_status,
    linear_projection_next_attempt_at = case when p_succeeded then now()
      else now() + least(interval '15 minutes',
        interval '5 seconds' * power(2::double precision,
          least(selected.linear_projection_attempt_count, 8)::double precision)) end,
    linear_projection_lease_expires_at = null,
    linear_projection_last_error_code = case when p_succeeded then null else p_error_code end,
    linear_projection_completed_at = case when p_succeeded
      then coalesce(run.linear_projection_completed_at, now()) else null end,
    updated_at = now()
  where run.dispatch_id = p_dispatch_id;
  return next_status;
end;
$$;

create function momi_agent_ops.requeue_terminal_projection_v1(
  p_dispatch_id uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update momi_agent_ops.run_records run set
    linear_projection_status = 'retryable',
    linear_projection_next_attempt_at = now(),
    linear_projection_lease_expires_at = null,
    updated_at = now()
  where run.dispatch_id = p_dispatch_id
    and run.terminal_at is not null
    and run.linear_projection_status in ('retryable', 'failed');
  return found;
end;
$$;

grant all on function momi_agent_ops.record_terminal_v6(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb
), momi_agent_ops.claim_terminal_projection_v1(uuid),
  momi_agent_ops.record_terminal_projection_result_v1(uuid, boolean, uuid, text),
  momi_agent_ops.requeue_terminal_projection_v1(uuid) to service_role;

revoke all on function momi_agent_ops.record_terminal_v6(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb
), momi_agent_ops.claim_terminal_projection_v1(uuid),
  momi_agent_ops.record_terminal_projection_result_v1(uuid, boolean, uuid, text),
  momi_agent_ops.requeue_terminal_projection_v1(uuid)
  from public, anon, authenticated;
