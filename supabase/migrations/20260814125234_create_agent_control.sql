-- service-owner: agent-control

create schema momi_agent_ops;
revoke all on schema momi_agent_ops from public, anon, authenticated, service_role;

create table momi_agent_ops.project_mappings (
  linear_project_id uuid primary key,
  linear_project_name text not null check (length(linear_project_name) between 1 and 240),
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  base_branch text not null check (base_branch ~ '^[A-Za-z0-9._/-]+$'),
  active_states text[] not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(active_states) between 1 and 12)
);

insert into momi_agent_ops.project_mappings (
  linear_project_id, linear_project_name, repository, base_branch, active_states
) values (
  'a7932d3c-82c7-477b-9942-3ccaf7a39d06', 'Backend Stabilization',
  'thedoughmonster/momi-backend', 'dev', array['Todo', 'In Progress', 'Rework']
);

create table momi_agent_ops.raw_webhook_envelopes (
  delivery_id uuid primary key,
  webhook_id uuid,
  received_at timestamptz not null default now(),
  last_received_at timestamptz not null default now(),
  replay_count integer not null default 0 check (replay_count between 0 and 1000000),
  replay_conflict_at timestamptz,
  raw_body bytea not null check (octet_length(raw_body) between 2 and 131072),
  payload jsonb,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  auth_result text not null check (auth_result in (
    'verified', 'signature_failed', 'stale', 'invalid_payload'
  )),
  event_type text,
  event_action text,
  check (payload is null or jsonb_typeof(payload) = 'object')
);

create table momi_agent_ops.dispatches (
  dispatch_id uuid primary key default gen_random_uuid(),
  receipt_delivery_id uuid not null unique
    references momi_agent_ops.raw_webhook_envelopes(delivery_id),
  idempotency_key text not null unique check (length(idempotency_key) between 1 and 240),
  linear_issue_id uuid not null,
  linear_issue_identifier text not null check (length(linear_issue_identifier) between 1 and 80),
  linear_issue_url text not null check (linear_issue_url ~ '^https://linear\.app/'),
  linear_project_id uuid,
  linear_project_name text,
  action text not null check (action = 'exec' || 'ute-run'),
  changed_fields jsonb not null check (jsonb_typeof(changed_fields) = 'object'),
  mapped_repository text,
  mapped_base_branch text,
  active_states text[],
  rejection_code text check (rejection_code in ('unknown_project')),
  work_status text not null default 'pending' check (work_status in (
    'pending', 'claimed', 'writeback_pending', 'active', 'completed',
    'rejected', 'dead_letter'
  )),
  attempt_count integer not null default 0 check (attempt_count between 0 and 8),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  capability_token_hash text not null check (capability_token_hash ~ '^[0-9a-f]{64}$'),
  host_callback_token_hash text check (
    host_callback_token_hash is null or host_callback_token_hash ~ '^[0-9a-f]{64}$'
  ),
  wake_capability_token uuid,
  codex_thread_id text,
  codex_turn_id text,
  last_error_code text check (last_error_code is null or length(last_error_code) <= 120),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  host_accepted_at timestamptz,
  completed_at timestamptz
);

create index dispatches_due_idx on momi_agent_ops.dispatches (
  next_attempt_at, dispatch_id
) where work_status in ('pending', 'claimed', 'writeback_pending');

create table momi_agent_ops.run_records (
  run_id uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null unique references momi_agent_ops.dispatches(dispatch_id),
  readiness_result text not null default 'pending' check (readiness_result in (
    'pending', 'ready', 'unready', 'failed', 'unknown_project'
  )),
  linear_comment_id uuid,
  execute_run_removed_at timestamptz,
  has_run_added_at timestamptz,
  linear_writeback_at timestamptz,
  terminal_disposition text check (terminal_disposition in (
    'completed', 'failed', 'interrupted'
  )),
  terminal_summary text check (terminal_summary is null or length(terminal_summary) <= 1000),
  terminal_at timestamptz,
  archive_state text not null default 'pending' check (archive_state in (
    'pending', 'archived', 'failed'
  )),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table momi_agent_ops.project_mappings enable row level security;
alter table momi_agent_ops.raw_webhook_envelopes enable row level security;
alter table momi_agent_ops.dispatches enable row level security;
alter table momi_agent_ops.run_records enable row level security;
revoke all on all tables in schema momi_agent_ops from public, anon, authenticated, service_role;

create function momi_agent_ops.accept_linear_webhook_v1(
  p_delivery_id uuid, p_webhook_id uuid, p_raw_body_hex text, p_payload jsonb,
  p_auth_result text, p_event_type text, p_event_action text,
  p_issue_id uuid, p_issue_identifier text, p_issue_url text,
  p_project_id uuid, p_project_name text, p_execute_run_added boolean,
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
  if p_event_type <> 'Issue' or p_event_action <> 'update'
    or not coalesce(p_execute_run_added, false) then
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
    p_delivery_id, 'linear:' || p_delivery_id::text || ':exec' || 'ute-run', p_issue_id,
    p_issue_identifier, p_issue_url, p_project_id, p_project_name,
    'exec' || 'ute-run', p_changed_fields, selected_mapping.repository,
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

create function momi_agent_ops.claim_dispatch_v1(
  p_dispatch_id uuid, p_capability_token uuid
) returns table (
  work_id uuid, issue_id uuid, issue_identifier text, issue_url text,
  project_id uuid, project_name text, repository text, base_branch text,
  active_states text[], rejection_code text, delivery_phase text,
  thread_id text, turn_id text, linear_comment_id uuid
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
    selected.active_states, selected.rejection_code,
    case when selected.codex_thread_id is null and selected.rejection_code is null
      then 'host' else 'writeback' end,
    selected.codex_thread_id, selected.codex_turn_id, run.linear_comment_id
  from momi_agent_ops.run_records run where run.dispatch_id = selected.dispatch_id;
end;
$$;

create function momi_agent_ops.record_host_acceptance_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update momi_agent_ops.dispatches work set
    codex_thread_id = p_thread_id, codex_turn_id = p_turn_id,
    host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex'),
    work_status = 'writeback_pending', host_accepted_at = coalesce(work.host_accepted_at, now()),
    lease_expires_at = now() + interval '90 seconds'
  where work.dispatch_id = p_dispatch_id
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.work_status in ('claimed', 'writeback_pending')
    and (work.codex_thread_id is null or work.codex_thread_id = p_thread_id)
    and (work.codex_turn_id is null or work.codex_turn_id = p_turn_id);
  return found;
end;
$$;

create function momi_agent_ops.record_linear_writeback_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_comment_id uuid,
  p_execute_run_removed boolean, p_has_run_added boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update momi_agent_ops.run_records run set
    linear_comment_id = coalesce(run.linear_comment_id, p_comment_id),
    execute_run_removed_at = case when p_execute_run_removed
      then coalesce(run.execute_run_removed_at, now()) else run.execute_run_removed_at end,
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

create function momi_agent_ops.record_terminal_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_readiness_result text, p_terminal_disposition text,
  p_terminal_summary text, p_archived_at timestamptz
) returns table (issue_id uuid, issue_identifier text, linear_comment_id uuid)
language plpgsql security definer set search_path = '' as $$
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
    run.linear_comment_id from momi_agent_ops.run_records run
    where run.dispatch_id = p_dispatch_id;
end;
$$;

create function momi_agent_ops.retry_dispatch_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_error_code text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare token uuid := gen_random_uuid();
begin
  update momi_agent_ops.dispatches work set
    work_status = case when work.attempt_count >= 8 then 'dead_letter' else 'pending' end,
    next_attempt_at = now() + make_interval(secs => least(300,
      5 * (2 ^ greatest(work.attempt_count - 1, 0))::integer)),
    lease_expires_at = null,
    capability_token_hash = case when work.attempt_count >= 8
      then work.capability_token_hash else encode(extensions.digest(
        convert_to(token::text, 'UTF8'), 'sha256'), 'hex') end,
    wake_capability_token = case when work.attempt_count >= 8 then null else token end,
    last_error_code = left(coalesce(nullif(p_error_code, ''), 'dispatch_failed'), 120)
  where work.dispatch_id = p_dispatch_id
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.work_status in ('claimed', 'writeback_pending');
  return found;
end;
$$;

create function momi_agent_ops.run_dispatch_recovery_v1()
returns integer language plpgsql security definer set search_path = '' as $$
declare affected integer;
begin
  with due as (
    select work.dispatch_id from momi_agent_ops.dispatches work
    where (work.work_status = 'pending' and work.next_attempt_at <= now())
      or (work.work_status in ('claimed', 'writeback_pending')
        and work.lease_expires_at <= now())
    order by coalesce(work.lease_expires_at, work.next_attempt_at), work.dispatch_id
    limit 4 for update skip locked
  ), tokens as (
    select due.dispatch_id, gen_random_uuid() token from due
  )
  update momi_agent_ops.dispatches work set
    work_status = case when work.attempt_count >= 8 then 'dead_letter' else 'pending' end,
    next_attempt_at = now(), lease_expires_at = null,
    wake_capability_token = case when work.attempt_count >= 8 then null else tokens.token end,
    capability_token_hash = case when work.attempt_count >= 8
      then work.capability_token_hash else encode(extensions.digest(
        convert_to(tokens.token::text, 'UTF8'), 'sha256'), 'hex') end
  from tokens where work.dispatch_id = tokens.dispatch_id;
  get diagnostics affected = row_count; return affected;
end;
$$;

grant usage on schema momi_agent_ops to service_role;
grant execute on function momi_agent_ops.accept_linear_webhook_v1(
  uuid, uuid, text, jsonb, text, text, text, uuid, text, text, uuid, text,
  boolean, jsonb
) to service_role;
grant execute on function momi_agent_ops.claim_dispatch_v1(uuid, uuid),
  momi_agent_ops.record_host_acceptance_v1(uuid, uuid, text, text),
  momi_agent_ops.record_linear_writeback_v1(uuid, uuid, uuid, boolean, boolean),
  momi_agent_ops.record_terminal_v1(uuid, uuid, text, text, text, text, text, timestamptz),
  momi_agent_ops.retry_dispatch_v1(uuid, uuid, text),
  momi_agent_ops.run_dispatch_recovery_v1() to service_role;
revoke all on function momi_agent_ops.accept_linear_webhook_v1(
  uuid, uuid, text, jsonb, text, text, text, uuid, text, text, uuid, text,
  boolean, jsonb
) from public, anon, authenticated;
revoke all on function momi_agent_ops.claim_dispatch_v1(uuid, uuid),
  momi_agent_ops.record_host_acceptance_v1(uuid, uuid, text, text),
  momi_agent_ops.record_linear_writeback_v1(uuid, uuid, uuid, boolean, boolean),
  momi_agent_ops.record_terminal_v1(uuid, uuid, text, text, text, text, text, timestamptz),
  momi_agent_ops.retry_dispatch_v1(uuid, uuid, text),
  momi_agent_ops.run_dispatch_recovery_v1() from public, anon, authenticated;
