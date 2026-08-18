-- service-owner: agent-control

alter table momi_agent_ops.project_mappings
  add column host_dispatch_url text;

alter table momi_agent_ops.project_mappings
  add constraint project_mappings_host_dispatch_url_https
  check (host_dispatch_url is null or host_dispatch_url ~ '^https://[^[:space:]]+$');

create function momi_agent_ops.claim_dispatch_v2(
  p_dispatch_id uuid, p_capability_token uuid
) returns table (
  work_id uuid, issue_id uuid, issue_identifier text, issue_url text,
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
    selected.linear_issue_identifier, selected.linear_issue_url,
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

grant execute on function momi_agent_ops.claim_dispatch_v2(uuid, uuid) to service_role;
revoke all on function momi_agent_ops.claim_dispatch_v2(uuid, uuid)
  from public, anon, authenticated;
