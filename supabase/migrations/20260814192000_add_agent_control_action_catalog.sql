-- service-owner: agent-control

alter table momi_agent_ops.dispatches
  drop constraint dispatches_action_check;

alter table momi_agent_ops.dispatches
  add constraint dispatches_action_check check (action in (
    'exec' || 'ute-run', 'validate-issue', 'investigate-issue',
    'cleanup', 'decompose', 'run-discovery'
  ));

alter table momi_agent_ops.run_records
  add column action_label_removed_at timestamptz;

create function momi_agent_ops.accept_linear_webhook_v2(
  p_delivery_id uuid, p_webhook_id uuid, p_raw_body_hex text, p_payload jsonb,
  p_auth_result text, p_event_type text, p_event_action text,
  p_issue_id uuid, p_issue_identifier text, p_issue_url text,
  p_project_id uuid, p_project_name text, p_action text,
  p_changed_fields jsonb
) returns table (disposition text, dispatch_id uuid) language plpgsql
security definer set search_path = '' as $$
declare
  existing momi_agent_ops.raw_webhook_envelopes%rowtype;
  selected_mapping momi_agent_ops.project_mappings%rowtype;
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
    'exec' || 'ute-run', 'validate-issue', 'investigate-issue',
    'cleanup', 'decompose', 'run-discovery'
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
  token := gen_random_uuid();
  insert into momi_agent_ops.dispatches as created (
    receipt_delivery_id, idempotency_key, linear_issue_id,
    linear_issue_identifier, linear_issue_url, linear_project_id,
    linear_project_name, action, changed_fields, mapped_repository,
    mapped_base_branch, active_states, rejection_code,
    capability_token_hash, wake_capability_token
  ) values (
    p_delivery_id, 'linear:' || p_delivery_id::text || ':' || p_action, p_issue_id,
    p_issue_identifier, p_issue_url, p_project_id, p_project_name,
    p_action, p_changed_fields, selected_mapping.repository,
    selected_mapping.base_branch, selected_mapping.active_states,
    case when selected_mapping.linear_project_id is null then 'unknown_project' end,
    encode(extensions.digest(convert_to(token::text, 'UTF8'), 'sha256'), 'hex'), token
  ) returning created.dispatch_id into created_dispatch;

  insert into momi_agent_ops.run_records (dispatch_id, readiness_result)
  values (created_dispatch, case when selected_mapping.linear_project_id is null
    then 'unknown_project' else 'pending' end);
  disposition := 'accepted'; dispatch_id := created_dispatch; return next;
end;
$$;

create function momi_agent_ops.claim_dispatch_v3(
  p_dispatch_id uuid, p_capability_token uuid
) returns table (
  work_id uuid, issue_id uuid, issue_identifier text, action text, issue_url text,
  project_id uuid, project_name text, repository text, base_branch text,
  active_states text[], host_dispatch_url text, rejection_code text,
  delivery_phase text, thread_id text, turn_id text, linear_comment_id uuid
) language plpgsql security definer set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
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
  return query select selected.dispatch_id, selected.linear_issue_id,
    selected.linear_issue_identifier, selected.action, selected.linear_issue_url,
    selected.linear_project_id, selected.linear_project_name,
    selected.mapped_repository, selected.mapped_base_branch,
    selected.active_states, mapping.host_dispatch_url, selected.rejection_code,
    case when selected.codex_thread_id is null and selected.rejection_code is null
      then 'host' else 'writeback' end,
    selected.codex_thread_id, selected.codex_turn_id, run.linear_comment_id
  from momi_agent_ops.run_records run
  left join momi_agent_ops.project_mappings mapping
    on mapping.linear_project_id = selected.linear_project_id and mapping.active
  where run.dispatch_id = selected.dispatch_id;
end;
$$;

create function momi_agent_ops.record_linear_writeback_v2(
  p_dispatch_id uuid, p_capability_token uuid, p_comment_id uuid,
  p_action_label_removed boolean, p_has_run_added boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
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
      );
  if not found then return false; end if;
  update momi_agent_ops.dispatches work set
    work_status = case when work.rejection_code is null
      then case when work.work_status = 'completed' then 'completed' else 'active' end
      else 'rejected' end,
    lease_expires_at = null,
    completed_at = case when work.rejection_code is null then work.completed_at
      else coalesce(work.completed_at, now()) end
  where work.dispatch_id = p_dispatch_id;
  return true;
end;
$$;

create function momi_agent_ops.record_terminal_v2(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_readiness_result text, p_terminal_disposition text,
  p_terminal_summary text, p_archived_at timestamptz
) returns table (
  issue_id uuid, issue_identifier text, action text, linear_comment_id uuid
) language plpgsql security definer set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
begin
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
  update momi_agent_ops.dispatches work set work_status = 'completed',
    completed_at = coalesce(work.completed_at, now()), lease_expires_at = null
  where work.dispatch_id = p_dispatch_id;
  update momi_agent_ops.run_records run set readiness_result = p_readiness_result,
    terminal_disposition = p_terminal_disposition,
    terminal_summary = left(nullif(p_terminal_summary, ''), 1000),
    terminal_at = coalesce(run.terminal_at, now()), archive_state = 'archived',
    archived_at = coalesce(run.archived_at, p_archived_at), updated_at = now()
  where run.dispatch_id = p_dispatch_id;
  return query select selected.linear_issue_id, selected.linear_issue_identifier,
    selected.action, run.linear_comment_id from momi_agent_ops.run_records run
    where run.dispatch_id = p_dispatch_id;
end;
$$;

grant execute on function momi_agent_ops.accept_linear_webhook_v2(
  uuid, uuid, text, jsonb, text, text, text, uuid, text, text, uuid, text,
  text, jsonb
), momi_agent_ops.claim_dispatch_v3(uuid, uuid),
  momi_agent_ops.record_linear_writeback_v2(uuid, uuid, uuid, boolean, boolean),
  momi_agent_ops.record_terminal_v2(
    uuid, uuid, text, text, text, text, text, timestamptz
  ) to service_role;

revoke all on function momi_agent_ops.accept_linear_webhook_v2(
  uuid, uuid, text, jsonb, text, text, text, uuid, text, text, uuid, text,
  text, jsonb
), momi_agent_ops.claim_dispatch_v3(uuid, uuid),
  momi_agent_ops.record_linear_writeback_v2(uuid, uuid, uuid, boolean, boolean),
  momi_agent_ops.record_terminal_v2(
    uuid, uuid, text, text, text, text, text, timestamptz
  ) from public, anon, authenticated;
