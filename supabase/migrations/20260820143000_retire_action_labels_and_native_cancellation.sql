-- service-owner: agent-control

alter table momi_agent_ops.dispatches
  drop constraint dispatches_source_kind_check,
  drop constraint dispatch_source_shape;

alter table momi_agent_ops.dispatches
  add column validation_profile text not null default 'normal' check (
    validation_profile in ('normal', 'escalated')
  ),
  add constraint dispatches_source_kind_check check (
    source_kind in ('linear_action', 'ready_leaf_scheduler', 'linear_state_cancellation')
  ),
  add constraint dispatch_source_shape check (
    (source_kind = 'linear_action' and receipt_delivery_id is not null
      and scheduler_candidate_id is null and scheduler_generation is null)
    or
    (source_kind = 'linear_state_cancellation' and receipt_delivery_id is not null
      and scheduler_candidate_id is null and scheduler_generation is null
      and action = 'cancel-run')
    or
    (source_kind = 'ready_leaf_scheduler' and receipt_delivery_id is null
      and scheduler_candidate_id is not null and scheduler_generation > 0
      and action = ('exec' || 'ute-run'))
  ),
  add constraint dispatch_validation_profile_shape check (
    validation_profile = 'normal'
    or (source_kind = 'ready_leaf_scheduler' and action = ('exec' || 'ute-run'))
  );

create function momi_agent_ops.accept_linear_webhook_v5(
  p_delivery_id uuid, p_webhook_id uuid, p_raw_body_hex text, p_payload jsonb,
  p_auth_result text, p_event_type text, p_event_action text,
  p_issue_id uuid, p_issue_identifier text, p_issue_url text,
  p_project_id uuid, p_project_name text, p_parent_issue_id uuid,
  p_action text, p_changed_fields jsonb
) returns table (disposition text, dispatch_id uuid) language plpgsql
security invoker set search_path = '' as $$
declare
  existing momi_agent_ops.raw_webhook_envelopes%rowtype;
  selected_mapping momi_agent_ops.project_mappings%rowtype;
  selected_parent momi_agent_ops.dispatches%rowtype;
  selected_target momi_agent_ops.dispatches%rowtype;
  selected_archive_state text;
  target_count integer := 0;
  queued_count integer := 0;
  active_count integer := 0;
  ambiguous_count integer := 0;
  cancellation text := 'not_requested';
  recovery text := 'not_requested';
  raw_bytes bytea;
  raw_hash text;
  token uuid;
  created_dispatch uuid;
  native_canceled boolean;
begin
  if p_delivery_id is null or p_raw_body_hex is null
    or p_raw_body_hex !~ '^[0-9a-f]+$' or length(p_raw_body_hex) % 2 <> 0 then
    raise exception 'invalid Linear delivery envelope' using errcode = '22023';
  end if;
  if p_action is not null and p_action not in (
    'exec' || 'ute-run', 'cancel-run', 'investigate-issue',
    'run-discovery', 'recover-discovery'
  ) then
    raise exception 'invalid Linear action' using errcode = '22023';
  end if;
  raw_bytes := decode(p_raw_body_hex, 'hex');
  raw_hash := encode(extensions.digest(raw_bytes, 'sha256'), 'hex');

  select receipt.* into existing from momi_agent_ops.raw_webhook_envelopes receipt
  where receipt.delivery_id = p_delivery_id for update;
  if found then
    update momi_agent_ops.raw_webhook_envelopes receipt set
      replay_count = receipt.replay_count + 1, last_received_at = now(),
      replay_conflict_at = case when receipt.payload_sha256 <> raw_hash
        then now() else receipt.replay_conflict_at end
    where receipt.delivery_id = p_delivery_id;
    disposition := 'duplicate'; dispatch_id := null; return next; return;
  end if;

  insert into momi_agent_ops.raw_webhook_envelopes (
    delivery_id, webhook_id, raw_body, payload, payload_sha256, auth_result,
    event_type, event_action
  ) values (
    p_delivery_id, p_webhook_id, raw_bytes, p_payload, raw_hash, p_auth_result,
    p_event_type, p_event_action
  );

  if p_auth_result <> 'verified' then
    disposition := 'rejected'; dispatch_id := null; return next; return;
  end if;
  if p_event_type <> 'Issue' or p_event_action <> 'update' or p_action is null then
    disposition := 'ignored'; dispatch_id := null; return next; return;
  end if;
  if p_issue_id is null or p_issue_identifier is null or p_issue_url is null
    or p_changed_fields is null then
    raise exception 'invalid normalized Linear action' using errcode = '22023';
  end if;
  native_canceled := p_action = 'cancel-run' and (
    lower(coalesce(p_changed_fields #>> '{state,afterType}', '')) = 'canceled'
    or lower(coalesce(p_changed_fields #>> '{state,afterName}', '')) = 'canceled'
  );
  if p_action = 'cancel-run' and not native_canceled then
    disposition := 'ignored'; dispatch_id := null; return next; return;
  end if;

  select mapping.* into selected_mapping from momi_agent_ops.project_mappings mapping
  where mapping.linear_project_id = p_project_id and mapping.active;

  if p_action = ('exec' || 'ute-run') then
    if p_parent_issue_id is null then
      disposition := 'ignored'; dispatch_id := null; return next; return;
    end if;
    select parent.* into selected_parent from momi_agent_ops.dispatches parent
    where parent.linear_issue_id = p_parent_issue_id
      and parent.linear_project_id = p_project_id
      and parent.action = ('exec' || 'ute-run')
      and parent.mapped_repository = selected_mapping.repository
      and parent.mapped_base_branch = selected_mapping.base_branch
      and parent.work_status in ('claimed', 'writeback_pending', 'active')
    order by parent.created_at desc, parent.dispatch_id desc limit 1;
    if selected_parent.dispatch_id is null then
      disposition := 'ignored'; dispatch_id := null; return next; return;
    end if;
    select child.dispatch_id into created_dispatch
    from momi_agent_ops.dispatches child
    where child.parent_dispatch_id = selected_parent.dispatch_id
      and child.linear_issue_id = p_issue_id
      and child.action = ('exec' || 'ute-run');
    if found then
      disposition := 'duplicate'; dispatch_id := created_dispatch; return next; return;
    end if;
  end if;

  if native_canceled and selected_mapping.linear_project_id is not null then
    select target.* into selected_target from momi_agent_ops.dispatches target
    where target.linear_issue_id = p_issue_id
      and target.linear_project_id = p_project_id
      and target.action = ('exec' || 'ute-run')
    order by target.created_at desc, target.dispatch_id desc limit 1 for update;
    if selected_target.dispatch_id is null then
      cancellation := 'no_target';
    elsif selected_target.mapped_repository is distinct from selected_mapping.repository
      or selected_target.mapped_base_branch is distinct from selected_mapping.base_branch then
      cancellation := 'operator_intervention';
    else
      with recursive lifecycle as (
        select selected_target.dispatch_id
        union all
        select child.dispatch_id from momi_agent_ops.dispatches child
        join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
        where child.action = ('exec' || 'ute-run')
      )
      select
        count(*) filter (where work.work_status = 'pending'),
        count(*) filter (where work.work_status in ('claimed', 'writeback_pending', 'active')
          and work.codex_thread_id is not null and work.codex_turn_id is not null),
        count(*) filter (where work.work_status not in (
            'pending', 'completed', 'cancelled', 'rejected', 'dead_letter')
          and not (work.work_status in ('claimed', 'writeback_pending', 'active')
            and work.codex_thread_id is not null and work.codex_turn_id is not null))
      into queued_count, active_count, ambiguous_count
      from lifecycle owned join momi_agent_ops.dispatches work
        on work.dispatch_id = owned.dispatch_id;
      cancellation := case
        when ambiguous_count > 0 then 'operator_intervention'
        when active_count > 0 then 'requested'
        when queued_count > 0 then 'queued_cancelled'
        else 'already_terminal'
      end;

      with recursive lifecycle as (
        select selected_target.dispatch_id
        union all
        select child.dispatch_id from momi_agent_ops.dispatches child
        join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
        where child.action = ('exec' || 'ute-run')
      )
      update momi_agent_ops.dispatches target set
        work_status = 'cancelled',
        cancellation_requested_at = coalesce(target.cancellation_requested_at, now()),
        cancelled_at = coalesce(target.cancelled_at, now()),
        completed_at = coalesce(target.completed_at, now()),
        wake_capability_token = null, lease_expires_at = null
      where target.dispatch_id in (select owned.dispatch_id from lifecycle owned)
        and target.work_status = 'pending';

      with recursive lifecycle as (
        select selected_target.dispatch_id
        union all
        select child.dispatch_id from momi_agent_ops.dispatches child
        join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
        where child.action = ('exec' || 'ute-run')
      )
      update momi_agent_ops.dispatches target set
        cancellation_requested_at = coalesce(target.cancellation_requested_at, now())
      where target.dispatch_id in (select owned.dispatch_id from lifecycle owned)
        and target.work_status in ('claimed', 'writeback_pending', 'active');

      with recursive lifecycle as (
        select selected_target.dispatch_id
        union all
        select child.dispatch_id from momi_agent_ops.dispatches child
        join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
        where child.action = ('exec' || 'ute-run')
      )
      update momi_agent_ops.run_records run set readiness_result = 'unready',
        terminal_disposition = 'interrupted',
        terminal_summary = 'Native Linear cancellation withdrew queued work before host delivery.',
        terminal_at = coalesce(run.terminal_at, now()), archive_state = 'not_applicable',
        updated_at = now()
      where run.dispatch_id in (select owned.dispatch_id from lifecycle owned)
        and exists (select 1 from momi_agent_ops.dispatches target
          where target.dispatch_id = run.dispatch_id and target.work_status = 'cancelled');
    end if;
  end if;

  if p_action = 'recover-discovery'
    and selected_mapping.linear_project_id is not null then
    select count(*) into target_count
    from momi_agent_ops.dispatches target
    join momi_agent_ops.run_records run on run.dispatch_id = target.dispatch_id
    where target.linear_issue_id = p_issue_id
      and target.linear_project_id = p_project_id
      and target.action = 'run-discovery'
      and target.work_status in ('claimed', 'writeback_pending', 'active')
      and run.archive_state = 'pending';
    if target_count > 1 then
      recovery := 'ambiguous_target';
    else
      if target_count = 1 then
        select target.* into selected_target
        from momi_agent_ops.dispatches target
        join momi_agent_ops.run_records run on run.dispatch_id = target.dispatch_id
        where target.linear_issue_id = p_issue_id
          and target.linear_project_id = p_project_id
          and target.action = 'run-discovery'
          and target.work_status in ('claimed', 'writeback_pending', 'active')
          and run.archive_state = 'pending'
        order by target.created_at desc, target.dispatch_id desc limit 1 for update;
      else
        select target.* into selected_target
        from momi_agent_ops.dispatches target
        where target.linear_issue_id = p_issue_id
          and target.linear_project_id = p_project_id
          and target.action = 'run-discovery'
        order by target.created_at desc, target.dispatch_id desc limit 1 for update;
      end if;
      if selected_target.dispatch_id is not null then
        select run.archive_state into selected_archive_state
        from momi_agent_ops.run_records run
        where run.dispatch_id = selected_target.dispatch_id;
      end if;
      recovery := case
        when selected_target.dispatch_id is null then 'no_target'
        when selected_target.mapped_repository is distinct from selected_mapping.repository
          or selected_target.mapped_base_branch is distinct from selected_mapping.base_branch
          then 'mapping_mismatch'
        when selected_archive_state = 'archived' then 'already_archived'
        when target_count = 1 and selected_target.codex_thread_id is not null
          then 'requested'
        else 'ambiguous_target'
      end;
      if recovery in ('no_target', 'ambiguous_target') then
        selected_target.dispatch_id := null;
      end if;
    end if;
  end if;

  token := gen_random_uuid();
  insert into momi_agent_ops.dispatches as created (
    receipt_delivery_id, idempotency_key, linear_issue_id,
    linear_issue_identifier, linear_issue_url, linear_project_id,
    linear_project_name, action, changed_fields, mapped_repository,
    mapped_base_branch, active_states, rejection_code,
    capability_token_hash, wake_capability_token, parent_dispatch_id,
    target_dispatch_id, cancellation_state, recovery_state, source_kind
  ) values (
    p_delivery_id, 'linear:' || p_delivery_id::text || ':' || p_action, p_issue_id,
    p_issue_identifier, p_issue_url, p_project_id, p_project_name,
    p_action, p_changed_fields, selected_mapping.repository,
    selected_mapping.base_branch, selected_mapping.active_states,
    case when selected_mapping.linear_project_id is null then 'unknown_project' end,
    encode(extensions.digest(convert_to(token::text, 'UTF8'), 'sha256'), 'hex'), token,
    selected_parent.dispatch_id, selected_target.dispatch_id, cancellation, recovery,
    case when native_canceled then 'linear_state_cancellation' else 'linear_action' end
  ) returning created.dispatch_id into created_dispatch;

  insert into momi_agent_ops.run_records (dispatch_id, readiness_result)
  values (created_dispatch, case when selected_mapping.linear_project_id is null
    then 'unknown_project' else 'pending' end);
  disposition := 'accepted'; dispatch_id := created_dispatch; return next;
end;
$$;

create function momi_agent_ops.claim_dispatch_v6(
  p_dispatch_id uuid, p_capability_token uuid
) returns table (
  work_id uuid, issue_id uuid, issue_identifier text, action text, source_kind text,
  validation_profile text, issue_url text, project_id uuid, project_name text,
  repository text, base_branch text, active_states text[], host_dispatch_url text,
  rejection_code text, delivery_phase text, thread_id text, turn_id text,
  linear_comment_id uuid, parent_dispatch_id uuid, target_dispatch_id uuid,
  cancellation_target_ids uuid[], cancellation_state text, recovery_state text
) language plpgsql security invoker set search_path = '' as $$
declare
  selected momi_agent_ops.dispatches%rowtype;
  current_mapping momi_agent_ops.project_mappings%rowtype;
  targets uuid[] := '{}'::uuid[];
begin
  update momi_agent_ops.dispatches work set
    work_status = 'claimed', attempt_count = work.attempt_count + 1,
    claimed_at = now(), lease_expires_at = now() + interval '90 seconds',
    last_error_code = null
  where work.dispatch_id = p_dispatch_id
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.attempt_count < 8 and (
      (work.work_status = 'pending' and work.next_attempt_at <= now())
      or (work.work_status in ('claimed', 'writeback_pending')
        and work.lease_expires_at <= now())
    ) returning work.* into selected;
  if not found then return; end if;
  select mapping.* into current_mapping from momi_agent_ops.project_mappings mapping
  where mapping.linear_project_id = selected.linear_project_id and mapping.active;
  if current_mapping.linear_project_id is null
    or current_mapping.repository is distinct from selected.mapped_repository
    or current_mapping.base_branch is distinct from selected.mapped_base_branch then
    update momi_agent_ops.dispatches work set rejection_code = 'unknown_project'
    where work.dispatch_id = selected.dispatch_id;
    selected.rejection_code := 'unknown_project';
  end if;
  if selected.action = 'recover-discovery' and selected.recovery_state = 'requested'
    and (current_mapping.linear_project_id is null
      or current_mapping.repository is distinct from selected.mapped_repository
      or current_mapping.base_branch is distinct from selected.mapped_base_branch) then
    update momi_agent_ops.dispatches work set recovery_state = 'mapping_mismatch'
    where work.dispatch_id = selected.dispatch_id;
    selected.recovery_state := 'mapping_mismatch';
  end if;
  if selected.action = 'cancel-run' and selected.cancellation_state = 'requested'
    and current_mapping.repository is not distinct from selected.mapped_repository
    and current_mapping.base_branch is not distinct from selected.mapped_base_branch then
    with recursive lifecycle as (
      select selected.target_dispatch_id as dispatch_id
      union all
      select child.dispatch_id from momi_agent_ops.dispatches child
      join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
      where child.action = ('exec' || 'ute-run')
    )
    select coalesce(array_agg(work.dispatch_id order by work.dispatch_id), '{}'::uuid[])
    into targets from lifecycle owned join momi_agent_ops.dispatches work
      on work.dispatch_id = owned.dispatch_id
    where work.work_status in ('claimed', 'writeback_pending', 'active')
      and work.codex_thread_id is not null and work.codex_turn_id is not null;
    if cardinality(targets) = 0 then
      update momi_agent_ops.dispatches work set cancellation_state = 'already_terminal'
      where work.dispatch_id = selected.dispatch_id;
      selected.cancellation_state := 'already_terminal';
    end if;
  end if;
  return query select selected.dispatch_id, selected.linear_issue_id,
    selected.linear_issue_identifier, selected.action, selected.source_kind,
    selected.validation_profile, selected.linear_issue_url,
    selected.linear_project_id, selected.linear_project_name,
    selected.mapped_repository, selected.mapped_base_branch,
    selected.active_states, current_mapping.host_dispatch_url, selected.rejection_code,
    case
      when selected.action = 'cancel-run' and selected.rejection_code is null
        and selected.cancellation_state = 'requested' and cardinality(targets) > 0
        then 'cancel_host'
      when selected.action = 'recover-discovery' and selected.rejection_code is null
        and selected.recovery_state = 'requested' then 'recover_host'
      when selected.action not in ('cancel-run', 'recover-discovery')
        and selected.codex_thread_id is null and selected.rejection_code is null then 'host'
      else 'writeback'
    end,
    selected.codex_thread_id, selected.codex_turn_id, run.linear_comment_id,
    selected.parent_dispatch_id, selected.target_dispatch_id, targets,
    selected.cancellation_state, selected.recovery_state
  from momi_agent_ops.run_records run where run.dispatch_id = selected.dispatch_id;
end;
$$;

create function momi_agent_ops.record_cancellation_v2(
  p_dispatch_id uuid, p_capability_token uuid, p_cancellation_state text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare selected_target uuid;
begin
  if p_cancellation_state not in ('requested', 'already_terminal') then
    raise exception 'invalid cancellation result' using errcode = '22023';
  end if;
  update momi_agent_ops.dispatches work set
    cancellation_state = p_cancellation_state, work_status = 'writeback_pending',
    lease_expires_at = now() + interval '90 seconds'
  where work.dispatch_id = p_dispatch_id and work.action = 'cancel-run'
    and work.target_dispatch_id is not null
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.work_status in ('claimed', 'writeback_pending')
  returning work.target_dispatch_id into selected_target;
  if not found then return false; end if;
  with recursive lifecycle as (
    select selected_target as dispatch_id
    union all
    select child.dispatch_id from momi_agent_ops.dispatches child
    join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
    where child.action = ('exec' || 'ute-run')
  )
  update momi_agent_ops.dispatches target set
    cancellation_requested_at = coalesce(target.cancellation_requested_at, now())
  where target.dispatch_id in (select owned.dispatch_id from lifecycle owned)
    and target.work_status in ('claimed', 'writeback_pending', 'active');
  return true;
end;
$$;

create function momi_agent_ops.record_linear_writeback_v5(
  p_dispatch_id uuid, p_capability_token uuid, p_comment_id uuid
) returns boolean language sql security invoker set search_path = '' as $$
  select momi_agent_ops.record_linear_writeback_v4(
    p_dispatch_id, p_capability_token, p_comment_id, false, false
  );
$$;

create function momi_agent_ops.record_lifecycle_evidence_v2(
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
declare selected momi_agent_ops.dispatches%rowtype;
begin
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
    and work.mapped_repository = p_repository and work.mapped_base_branch = p_base_branch
  for update;
  if not found or selected.cancellation_requested_at is not null
    or selected.work_status = 'cancelled' then return false; end if;
  return momi_agent_ops.record_lifecycle_evidence_v1(
    p_dispatch_id, p_capability_token, p_thread_id, p_turn_id,
    p_repository, p_base_branch, p_branch_name, p_pull_request_number,
    p_phase, p_status, p_revision_sha, p_merge_sha, p_workflow_run_id
  );
end;
$$;

create function momi_agent_ops.record_terminal_v4(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_readiness_result text, p_terminal_disposition text,
  p_terminal_summary text, p_archived_at timestamptz, p_telemetry jsonb
) returns table (
  issue_id uuid, issue_identifier text, action text, linear_comment_id uuid
) language plpgsql security invoker set search_path = '' as $$
declare
  selected momi_agent_ops.dispatches%rowtype;
  effective_readiness text;
  effective_disposition text;
  effective_summary text;
  canceled boolean;
begin
  if p_telemetry is null or jsonb_typeof(p_telemetry) <> 'object' then
    raise exception 'invalid execution telemetry' using errcode = '22023';
  end if;
  if p_readiness_result not in ('ready', 'unready', 'failed')
    or p_terminal_disposition not in ('completed', 'failed', 'interrupted')
    or p_archived_at is null then
    raise exception 'invalid terminal callback' using errcode = '22023';
  end if;
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
  for update;
  if not found then return; end if;
  canceled := selected.cancellation_requested_at is not null
    or selected.work_status = 'cancelled';
  effective_readiness := case when canceled then 'ready' else p_readiness_result end;
  effective_disposition := case when canceled then 'interrupted'
    else p_terminal_disposition end;
  effective_summary := case when canceled
    then 'Native Linear cancellation was durably confirmed for this exact lifecycle.'
    else p_terminal_summary end;

  update momi_agent_ops.dispatches work set
    work_status = case when canceled then 'cancelled' else 'completed' end,
    cancellation_requested_at = case when canceled
      then coalesce(work.cancellation_requested_at, now()) else work.cancellation_requested_at end,
    cancelled_at = case when canceled
      then coalesce(work.cancelled_at, now()) else work.cancelled_at end,
    completed_at = coalesce(work.completed_at, now()), lease_expires_at = null
  where work.dispatch_id = p_dispatch_id;
  update momi_agent_ops.run_records run set readiness_result = effective_readiness,
    terminal_disposition = effective_disposition,
    terminal_summary = left(nullif(effective_summary, ''), 1000),
    terminal_at = coalesce(run.terminal_at, now()), archive_state = 'archived',
    archived_at = coalesce(run.archived_at, p_archived_at), updated_at = now()
  where run.dispatch_id = p_dispatch_id;
  insert into momi_agent_ops.execution_attempt_telemetry (
    dispatch_id, policy_version, stable_prefix_fingerprint, context_fingerprint,
    input_tokens, cached_input_tokens, output_tokens, model_visible_tool_bytes,
    model_turns, no_progress_cycles, subagents, max_subagent_depth, retries,
    repeated_failure_fingerprints, elapsed_ms, terminal_disposition
  ) values (
    p_dispatch_id, p_telemetry->>'policy_version',
    p_telemetry->>'stable_prefix_fingerprint', p_telemetry->>'context_fingerprint',
    (p_telemetry->>'input_tokens')::bigint,
    (p_telemetry->>'cached_input_tokens')::bigint,
    (p_telemetry->>'output_tokens')::bigint,
    (p_telemetry->>'model_visible_tool_bytes')::bigint,
    (p_telemetry->>'model_turns')::integer,
    (p_telemetry->>'no_progress_cycles')::integer,
    (p_telemetry->>'subagents')::integer,
    (p_telemetry->>'max_subagent_depth')::integer,
    (p_telemetry->>'retries')::integer,
    (p_telemetry->>'repeated_failure_fingerprints')::integer,
    (p_telemetry->>'elapsed_ms')::bigint, effective_disposition
  ) on conflict (dispatch_id) do nothing;
  return query select selected.linear_issue_id, selected.linear_issue_identifier,
    selected.action, run.linear_comment_id from momi_agent_ops.run_records run
    where run.dispatch_id = p_dispatch_id;
end;
$$;

create function momi_agent_ops.claim_scheduler_candidate_v2(
  p_route_key text,
  p_owner_id uuid,
  p_release_sha text,
  p_leader_generation bigint,
  p_candidate_id uuid,
  p_candidate_generation bigint,
  p_snapshot_version bigint
) returns table (claimed boolean, dispatch_id uuid) language plpgsql
security invoker set search_path = '' as $$
declare result record;
begin
  select prior.* into result from momi_agent_ops.claim_scheduler_candidate_v1(
    p_route_key, p_owner_id, p_release_sha, p_leader_generation,
    p_candidate_id, p_candidate_generation, p_snapshot_version
  ) prior;
  if not found then return; end if;
  if result.claimed and result.dispatch_id is not null then
    update momi_agent_ops.dispatches work set validation_profile = case
      when exists (
        select 1 from momi_agent_ops.scheduler_candidates candidate,
          unnest(candidate.labels) label
        where candidate.candidate_id = p_candidate_id
          and lower(btrim(label)) = 'request escalated validation'
      ) then 'escalated' else 'normal' end
    where work.dispatch_id = result.dispatch_id;
  end if;
  return query select result.claimed, result.dispatch_id;
end;
$$;

grant all on function momi_agent_ops.accept_linear_webhook_v5(
  uuid, uuid, text, jsonb, text, text, text, uuid, text, text, uuid, text,
  uuid, text, jsonb
), momi_agent_ops.claim_dispatch_v6(uuid, uuid),
  momi_agent_ops.record_cancellation_v2(uuid, uuid, text),
  momi_agent_ops.record_linear_writeback_v5(uuid, uuid, uuid),
  momi_agent_ops.record_lifecycle_evidence_v2(
    uuid, uuid, text, text, text, text, text, bigint, text, text, text, text, text
  ),
  momi_agent_ops.record_terminal_v4(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb
  ) to service_role;

revoke all on function momi_agent_ops.accept_linear_webhook_v5(
  uuid, uuid, text, jsonb, text, text, text, uuid, text, text, uuid, text,
  uuid, text, jsonb
), momi_agent_ops.claim_dispatch_v6(uuid, uuid),
  momi_agent_ops.record_cancellation_v2(uuid, uuid, text),
  momi_agent_ops.record_linear_writeback_v5(uuid, uuid, uuid),
  momi_agent_ops.record_lifecycle_evidence_v2(
    uuid, uuid, text, text, text, text, text, bigint, text, text, text, text, text
  ),
  momi_agent_ops.record_terminal_v4(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb
  ),
  momi_agent_ops.claim_scheduler_candidate_v2(
    text, uuid, text, bigint, uuid, bigint, bigint
  ) from public, anon, authenticated, service_role;
