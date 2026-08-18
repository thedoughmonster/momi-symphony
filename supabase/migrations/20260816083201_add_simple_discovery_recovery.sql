-- service-owner: agent-control

alter table momi_agent_ops.dispatches
  drop constraint dispatches_action_check;

alter table momi_agent_ops.dispatches
  add constraint dispatches_action_check check (action in (
    'exec' || 'ute-run', 'cancel-run', 'validate-issue', 'investigate-issue',
    'cleanup', 'decompose', 'run-discovery', 'recover-discovery'
  ));

alter table momi_agent_ops.dispatches
  drop constraint dispatch_cancel_shape;

alter table momi_agent_ops.dispatches
  add column recovery_state text not null default 'not_requested' check (
    recovery_state in ('not_requested', 'requested', 'recovered',
      'already_archived', 'no_target', 'ambiguous_target', 'mapping_mismatch')
  ),
  add constraint dispatch_control_shape check (
    (action = 'cancel-run' and recovery_state = 'not_requested') or
    (action = 'recover-discovery' and cancellation_state = 'not_requested') or
    (action not in ('cancel-run', 'recover-discovery')
      and target_dispatch_id is null
      and cancellation_state = 'not_requested'
      and recovery_state = 'not_requested')
  ),
  add constraint dispatch_recovery_target_shape check (
    action <> 'recover-discovery' or
    (recovery_state in ('requested', 'recovered', 'already_archived', 'mapping_mismatch')
      and target_dispatch_id is not null) or
    (recovery_state in ('not_requested', 'no_target', 'ambiguous_target')
      and target_dispatch_id is null)
  );

create function momi_agent_ops.accept_linear_webhook_v4(
  p_delivery_id uuid, p_webhook_id uuid, p_raw_body_hex text, p_payload jsonb,
  p_auth_result text, p_event_type text, p_event_action text,
  p_issue_id uuid, p_issue_identifier text, p_issue_url text,
  p_project_id uuid, p_project_name text, p_parent_issue_id uuid,
  p_action text, p_changed_fields jsonb
) returns table (disposition text, dispatch_id uuid) language plpgsql
security definer set search_path = '' as $$
declare
  existing momi_agent_ops.raw_webhook_envelopes%rowtype;
  selected_mapping momi_agent_ops.project_mappings%rowtype;
  selected_parent momi_agent_ops.dispatches%rowtype;
  selected_target momi_agent_ops.dispatches%rowtype;
  selected_archive_state text;
  target_count integer := 0;
  cancellation text := 'not_requested';
  recovery text := 'not_requested';
  raw_bytes bytea;
  raw_hash text;
  token uuid;
  created_dispatch uuid;
begin
  if p_delivery_id is null or p_raw_body_hex is null
    or p_raw_body_hex !~ '^[0-9a-f]+$' or length(p_raw_body_hex) % 2 <> 0 then
    raise exception 'invalid Linear delivery envelope' using errcode = '22023';
  end if;
  if p_action is not null and p_action not in (
    'exec' || 'ute-run', 'cancel-run', 'validate-issue', 'investigate-issue',
    'cleanup', 'decompose', 'run-discovery', 'recover-discovery'
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

  select mapping.* into selected_mapping from momi_agent_ops.project_mappings mapping
  where mapping.linear_project_id = p_project_id and mapping.active;

  if p_action = ('exec' || 'ute-run') and p_parent_issue_id is not null then
    select parent.* into selected_parent from momi_agent_ops.dispatches parent
    where parent.linear_issue_id = p_parent_issue_id
      and parent.linear_project_id = p_project_id
      and parent.action = ('exec' || 'ute-run')
      and parent.work_status in ('claimed', 'writeback_pending', 'active')
    order by parent.created_at desc, parent.dispatch_id desc limit 1;
    if selected_parent.dispatch_id is not null then
      select child.dispatch_id into created_dispatch
      from momi_agent_ops.dispatches child
      where child.parent_dispatch_id = selected_parent.dispatch_id
        and child.linear_issue_id = p_issue_id
        and child.action = ('exec' || 'ute-run');
      if found then
        disposition := 'duplicate'; dispatch_id := created_dispatch; return next; return;
      end if;
    end if;
  end if;

  if p_action = 'cancel-run' and selected_mapping.linear_project_id is not null then
    select target.* into selected_target from momi_agent_ops.dispatches target
    where target.linear_issue_id = p_issue_id
      and target.linear_project_id = p_project_id
      and target.action = ('exec' || 'ute-run')
    order by target.created_at desc, target.dispatch_id desc limit 1 for update;
    cancellation := case
      when selected_target.dispatch_id is null then 'no_target'
      when selected_target.work_status = 'pending' then 'queued_cancelled'
      when selected_target.codex_thread_id is not null
        and selected_target.work_status in ('claimed', 'writeback_pending', 'active')
        then 'requested'
      when selected_target.work_status in (
        'completed', 'cancelled', 'rejected', 'dead_letter'
      ) then 'already_terminal'
      else 'operator_intervention'
    end;
    if cancellation = 'queued_cancelled' then
      update momi_agent_ops.dispatches target set work_status = 'cancelled',
        cancellation_requested_at = coalesce(target.cancellation_requested_at, now()),
        cancelled_at = coalesce(target.cancelled_at, now()),
        completed_at = coalesce(target.completed_at, now()),
        wake_capability_token = null, lease_expires_at = null
      where target.dispatch_id = selected_target.dispatch_id;
      update momi_agent_ops.run_records run set readiness_result = 'unready',
        terminal_disposition = 'interrupted',
        terminal_summary = 'Queued work was withdrawn before host delivery.',
        terminal_at = coalesce(run.terminal_at, now()), archive_state = 'not_applicable',
        updated_at = now()
      where run.dispatch_id = selected_target.dispatch_id;
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
    target_dispatch_id, cancellation_state, recovery_state
  ) values (
    p_delivery_id, 'linear:' || p_delivery_id::text || ':' || p_action, p_issue_id,
    p_issue_identifier, p_issue_url, p_project_id, p_project_name,
    p_action, p_changed_fields, selected_mapping.repository,
    selected_mapping.base_branch, selected_mapping.active_states,
    case when selected_mapping.linear_project_id is null then 'unknown_project' end,
    encode(extensions.digest(convert_to(token::text, 'UTF8'), 'sha256'), 'hex'), token,
    selected_parent.dispatch_id, selected_target.dispatch_id, cancellation, recovery
  ) returning created.dispatch_id into created_dispatch;

  insert into momi_agent_ops.run_records (dispatch_id, readiness_result)
  values (created_dispatch, case when selected_mapping.linear_project_id is null
    then 'unknown_project' else 'pending' end);
  disposition := 'accepted'; dispatch_id := created_dispatch; return next;
end;
$$;

create function momi_agent_ops.claim_dispatch_v5(
  p_dispatch_id uuid, p_capability_token uuid
) returns table (
  work_id uuid, issue_id uuid, issue_identifier text, action text, issue_url text,
  project_id uuid, project_name text, repository text, base_branch text,
  active_states text[], host_dispatch_url text, rejection_code text,
  delivery_phase text, thread_id text, turn_id text, linear_comment_id uuid,
  parent_dispatch_id uuid, target_dispatch_id uuid, cancellation_state text,
  recovery_state text
) language plpgsql security definer set search_path = '' as $$
declare
  selected momi_agent_ops.dispatches%rowtype;
  current_mapping momi_agent_ops.project_mappings%rowtype;
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
  if selected.action = 'recover-discovery' and selected.recovery_state = 'requested'
    and (current_mapping.linear_project_id is null
      or current_mapping.repository is distinct from selected.mapped_repository
      or current_mapping.base_branch is distinct from selected.mapped_base_branch) then
    update momi_agent_ops.dispatches work set recovery_state = 'mapping_mismatch'
    where work.dispatch_id = selected.dispatch_id;
    selected.recovery_state := 'mapping_mismatch';
  end if;
  return query select selected.dispatch_id, selected.linear_issue_id,
    selected.linear_issue_identifier, selected.action, selected.linear_issue_url,
    selected.linear_project_id, selected.linear_project_name,
    selected.mapped_repository, selected.mapped_base_branch,
    selected.active_states, current_mapping.host_dispatch_url, selected.rejection_code,
    case
      when selected.action = 'cancel-run' and selected.rejection_code is null
        and selected.cancellation_state = 'requested' then 'cancel_host'
      when selected.action = 'recover-discovery' and selected.rejection_code is null
        and selected.recovery_state = 'requested' then 'recover_host'
      when selected.action not in ('cancel-run', 'recover-discovery')
        and selected.codex_thread_id is null and selected.rejection_code is null then 'host'
      else 'writeback'
    end,
    selected.codex_thread_id, selected.codex_turn_id, run.linear_comment_id,
    selected.parent_dispatch_id, selected.target_dispatch_id,
    selected.cancellation_state, selected.recovery_state
  from momi_agent_ops.run_records run
  where run.dispatch_id = selected.dispatch_id;
end;
$$;

create function momi_agent_ops.record_recovery_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_recovery_state text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_recovery_state not in ('recovered', 'already_archived', 'no_target',
    'ambiguous_target', 'mapping_mismatch') then
    raise exception 'invalid recovery result' using errcode = '22023';
  end if;
  update momi_agent_ops.dispatches work set
    recovery_state = p_recovery_state, work_status = 'writeback_pending',
    lease_expires_at = now() + interval '90 seconds'
  where work.dispatch_id = p_dispatch_id and work.action = 'recover-discovery'
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.work_status in ('claimed', 'writeback_pending');
  return found;
end;
$$;

create function momi_agent_ops.record_linear_writeback_v4(
  p_dispatch_id uuid, p_capability_token uuid, p_comment_id uuid,
  p_action_label_removed boolean, p_has_run_added boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
begin
  update momi_agent_ops.run_records run set
    linear_comment_id = coalesce(run.linear_comment_id, p_comment_id),
    action_label_removed_at = case when p_action_label_removed
      then coalesce(run.action_label_removed_at, now()) else run.action_label_removed_at end,
    has_run_added_at = case when p_has_run_added
      then coalesce(run.has_run_added_at, now()) else run.has_run_added_at end,
    linear_writeback_at = now(), updated_at = now()
  from momi_agent_ops.dispatches work
  where run.dispatch_id = p_dispatch_id and work.dispatch_id = run.dispatch_id
    and encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex') in (
        work.capability_token_hash, work.host_callback_token_hash
      ) returning work.* into selected;
  if not found then return false; end if;
  update momi_agent_ops.dispatches work set
    work_status = case when work.action in ('cancel-run', 'recover-discovery')
      then 'completed'
      when work.rejection_code is null
        then case when work.work_status = 'completed' then 'completed' else 'active' end
      else 'rejected' end,
    lease_expires_at = null,
    completed_at = case when work.action in ('cancel-run', 'recover-discovery')
      or work.rejection_code is not null
      then coalesce(work.completed_at, now()) else work.completed_at end
  where work.dispatch_id = p_dispatch_id;
  if selected.action = 'cancel-run' and selected.rejection_code is null then
    update momi_agent_ops.run_records run set
      readiness_result = case when selected.cancellation_state in (
        'no_target', 'operator_intervention'
      ) then 'unready' else 'ready' end,
      terminal_disposition = case when selected.cancellation_state = 'operator_intervention'
        then 'failed' else 'completed' end,
      terminal_summary = case selected.cancellation_state
        when 'queued_cancelled' then 'Queued work was withdrawn before host delivery.'
        when 'requested' then 'The active Codex turn received an interruption request.'
        when 'already_terminal' then 'The target run was already terminal.'
        when 'no_target' then 'No prior exec' || 'ute-run exists for this issue.'
        else 'Host delivery is ambiguous; operator intervention is required.' end,
      terminal_at = coalesce(run.terminal_at, now()), archive_state = 'not_applicable',
      updated_at = now()
    where run.dispatch_id = p_dispatch_id;
  end if;
  if selected.action = 'recover-discovery' and selected.rejection_code is null then
    update momi_agent_ops.run_records run set
      readiness_result = case when selected.recovery_state in (
        'recovered', 'already_archived'
      ) then 'ready' else 'unready' end,
      terminal_disposition = 'completed',
      terminal_summary = case selected.recovery_state
        when 'recovered' then 'The exact retained discovery task was archived.'
        when 'already_archived' then 'The exact discovery task was already archived.'
        when 'no_target' then 'No retained discovery task exists for this issue.'
        when 'mapping_mismatch' then 'The retained discovery mapping no longer matches.'
        else 'The retained discovery task identity is ambiguous.' end,
      terminal_at = coalesce(run.terminal_at, now()), archive_state = 'not_applicable',
      updated_at = now()
    where run.dispatch_id = p_dispatch_id;
  end if;
  return true;
end;
$$;

grant execute on function momi_agent_ops.accept_linear_webhook_v4(
  uuid, uuid, text, jsonb, text, text, text, uuid, text, text, uuid, text,
  uuid, text, jsonb
), momi_agent_ops.claim_dispatch_v5(uuid, uuid),
  momi_agent_ops.record_recovery_v1(uuid, uuid, text),
  momi_agent_ops.record_linear_writeback_v4(uuid, uuid, uuid, boolean, boolean)
  to service_role;

revoke all on function momi_agent_ops.accept_linear_webhook_v4(
  uuid, uuid, text, jsonb, text, text, text, uuid, text, text, uuid, text,
  uuid, text, jsonb
), momi_agent_ops.claim_dispatch_v5(uuid, uuid),
  momi_agent_ops.record_recovery_v1(uuid, uuid, text),
  momi_agent_ops.record_linear_writeback_v4(uuid, uuid, uuid, boolean, boolean)
  from public, anon, authenticated;
