-- service-owner: agent-control

alter table momi_agent_ops.dispatches
  add column dead_letter_recovered_at timestamptz,
  add column dead_letter_recovery_owner_issue_identifier text,
  add column dead_letter_recovery_from_attempt_count integer,
  add column dead_letter_recovery_from_error_code text,
  add column dead_letter_recovery_host_dispatch_url text,
  add constraint dispatch_dead_letter_recovery_evidence_shape check (
    (dead_letter_recovered_at is null
      and dead_letter_recovery_owner_issue_identifier is null
      and dead_letter_recovery_from_attempt_count is null
      and dead_letter_recovery_from_error_code is null
      and dead_letter_recovery_host_dispatch_url is null)
    or
    (dead_letter_recovered_at is not null
      and dead_letter_recovery_owner_issue_identifier ~ '^[A-Z][A-Z0-9]*-[1-9][0-9]*$'
      and dead_letter_recovery_from_attempt_count between 1 and 8
      and length(dead_letter_recovery_from_error_code) between 1 and 120
      and dead_letter_recovery_host_dispatch_url ~ '^https://[^[:space:]]+/v1/dispatch$')
  );

create function momi_agent_ops.recover_dead_letter_dispatch_v1(
  p_dispatch_id uuid,
  p_expected_issue_identifier text,
  p_expected_attempt_count integer,
  p_expected_error_code text,
  p_expected_host_dispatch_url text,
  p_owner_issue_identifier text
) returns table (
  disposition text,
  recovered_dispatch_id uuid,
  recovery_timestamp timestamptz
) language plpgsql security definer set search_path = '' as $$
declare
  selected momi_agent_ops.dispatches%rowtype;
  selected_run momi_agent_ops.run_records%rowtype;
  selected_mapping momi_agent_ops.project_mappings%rowtype;
  fresh_capability uuid;
  recovered_at_value timestamptz;
begin
  if p_dispatch_id is null
    or p_expected_issue_identifier is null
    or p_expected_issue_identifier !~ '^[A-Z][A-Z0-9]*-[1-9][0-9]*$'
    or p_owner_issue_identifier is null
    or p_owner_issue_identifier !~ '^[A-Z][A-Z0-9]*-[1-9][0-9]*$'
    or p_owner_issue_identifier = p_expected_issue_identifier
    or p_expected_attempt_count is null
    or p_expected_attempt_count <> 8
    or p_expected_error_code is null
    or p_expected_error_code <> 'codex_host_delivery_failed'
    or p_expected_host_dispatch_url is null
    or p_expected_host_dispatch_url !~ '^https://[^[:space:]]+/v1/dispatch$' then
    raise exception 'invalid dead-letter recovery authority'
      using errcode = '22023';
  end if;

  select work.* into selected
  from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
  for update;
  if not found then
    raise exception 'dead-letter recovery target not found'
      using errcode = 'P0002';
  end if;

  if selected.dead_letter_recovered_at is not null then
    if selected.linear_issue_identifier = p_expected_issue_identifier
      and selected.dead_letter_recovery_from_attempt_count = p_expected_attempt_count
      and selected.dead_letter_recovery_from_error_code = p_expected_error_code
      and selected.dead_letter_recovery_host_dispatch_url = p_expected_host_dispatch_url
      and selected.dead_letter_recovery_owner_issue_identifier = p_owner_issue_identifier then
      return query select 'already_recovered'::text, selected.dispatch_id,
        selected.dead_letter_recovered_at;
      return;
    end if;
    raise exception 'conflicting dead-letter recovery replay'
      using errcode = '22023';
  end if;

  if selected.linear_issue_identifier <> p_expected_issue_identifier
    or selected.action <> ('exec' || 'ute-run')
    or selected.work_status <> 'dead_letter'
    or selected.attempt_count <> p_expected_attempt_count
    or selected.last_error_code is distinct from p_expected_error_code
    or selected.rejection_code is not null
    or selected.host_accepted_at is not null
    or selected.codex_thread_id is not null
    or selected.codex_turn_id is not null
    or selected.host_callback_token_hash is not null
    or selected.completed_at is not null
    or selected.cancellation_state <> 'not_requested'
    or selected.recovery_state <> 'not_requested' then
    raise exception 'dead-letter recovery preconditions changed'
      using errcode = '55000';
  end if;

  select run.* into selected_run
  from momi_agent_ops.run_records run
  where run.dispatch_id = selected.dispatch_id
  for update;
  if not found
    or selected_run.readiness_result <> 'pending'
    or selected_run.linear_comment_id is not null
    or selected_run.action_label_removed_at is not null
    or selected_run.execute_run_removed_at is not null
    or selected_run.has_run_added_at is not null
    or selected_run.linear_writeback_at is not null
    or selected_run.terminal_disposition is not null
    or selected_run.terminal_at is not null
    or selected_run.archive_state <> 'pending'
    or selected_run.archived_at is not null then
    raise exception 'dead-letter recovery run state changed'
      using errcode = '55000';
  end if;

  select mapping.* into selected_mapping
  from momi_agent_ops.project_mappings mapping
  where mapping.linear_project_id = selected.linear_project_id
    and mapping.active
  for share;
  if not found
    or selected_mapping.repository is distinct from selected.mapped_repository
    or selected_mapping.base_branch is distinct from selected.mapped_base_branch
    or selected_mapping.host_dispatch_url is distinct from p_expected_host_dispatch_url then
    raise exception 'dead-letter recovery mapping changed'
      using errcode = '55000';
  end if;

  fresh_capability := gen_random_uuid();
  recovered_at_value := clock_timestamp();
  update momi_agent_ops.dispatches work set
    dead_letter_recovered_at = recovered_at_value,
    dead_letter_recovery_owner_issue_identifier = p_owner_issue_identifier,
    dead_letter_recovery_from_attempt_count = selected.attempt_count,
    dead_letter_recovery_from_error_code = selected.last_error_code,
    dead_letter_recovery_host_dispatch_url = p_expected_host_dispatch_url,
    capability_token_hash = encode(extensions.digest(
      convert_to(fresh_capability::text, 'UTF8'), 'sha256'), 'hex'),
    wake_capability_token = fresh_capability,
    work_status = 'pending', attempt_count = 0,
    next_attempt_at = now(), lease_expires_at = null,
    claimed_at = null, last_error_code = null
  where work.dispatch_id = selected.dispatch_id;

  return query select 'recovered'::text, selected.dispatch_id,
    recovered_at_value;
end;
$$;

revoke all on function momi_agent_ops.recover_dead_letter_dispatch_v1(
  uuid, text, integer, text, text, text
) from public, anon, authenticated, service_role;
