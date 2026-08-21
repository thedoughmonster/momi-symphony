-- service-owner: agent-control

create table momi_agent_ops.review_attempts (
  review_attempt_id uuid primary key default gen_random_uuid(),
  implementation_dispatch_id uuid not null
    references momi_agent_ops.dispatches(dispatch_id),
  reviewer_dispatch_id uuid not null unique default gen_random_uuid(),
  parent_attempt_id uuid references momi_agent_ops.review_attempts(review_attempt_id),
  reviewer_callback_capability_hash text not null check (
    reviewer_callback_capability_hash ~ '^[0-9a-f]{64}$'
  ),
  repository text not null check (
    repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  ),
  pull_request_number bigint not null check (pull_request_number > 0),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  policy_version text not null check (length(policy_version) between 1 and 120),
  profile text not null check (profile in ('low', 'standard', 'high')),
  state text not null default 'pending' check (state in (
    'pending', 'accepted', 'changes_requested', 'failed', 'canceled'
  )),
  reviewer_identity text check (
    reviewer_identity is null or reviewer_identity = 'independent_reviewer'
  ),
  reviewer_thread_id text check (
    reviewer_thread_id is null or length(reviewer_thread_id) between 1 and 200
  ),
  reviewer_turn_id text check (
    reviewer_turn_id is null or length(reviewer_turn_id) between 1 and 200
  ),
  findings jsonb not null default '[]'::jsonb check (
    jsonb_typeof(findings) = 'array' and pg_column_size(findings) <= 65536
  ),
  failure_reason text check (
    failure_reason is null or length(failure_reason) between 1 and 500
  ),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz not null default now(),
  check (reviewer_dispatch_id <> implementation_dispatch_id),
  check (parent_attempt_id is null or parent_attempt_id <> review_attempt_id),
  check (
    state = 'pending' or terminal_at is not null
  ),
  check (
    state not in ('accepted', 'changes_requested') or (
      reviewer_identity = 'independent_reviewer'
      and reviewer_thread_id is not null
      and reviewer_turn_id is not null
    )
  ),
  check (
    state <> 'accepted' or not jsonb_path_exists(
      findings, '$[*] ? (@.severity == "blocking")'
    )
  ),
  check (
    state = 'failed' or failure_reason is null
  )
);

create unique index review_attempts_one_pending_idx
  on momi_agent_ops.review_attempts (implementation_dispatch_id)
  where state = 'pending';

create unique index review_attempts_one_accepted_subject_idx
  on momi_agent_ops.review_attempts (
    implementation_dispatch_id, repository, pull_request_number,
    head_sha, base_sha, policy_version
  ) where state = 'accepted';

create index review_attempts_current_subject_idx
  on momi_agent_ops.review_attempts (
    implementation_dispatch_id, repository, pull_request_number,
    head_sha, base_sha, policy_version, profile
  ) where state in ('pending', 'accepted');

create function momi_agent_ops.enforce_review_attempt_transition_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare implementation_thread_id text;
begin
  if tg_op = 'DELETE' then
    raise exception 'review_attempt_history_immutable' using errcode = '23514';
  end if;

  if new.reviewer_thread_id is not null then
    select work.codex_thread_id into implementation_thread_id
    from momi_agent_ops.dispatches work
    where work.dispatch_id = new.implementation_dispatch_id;
    if not found or new.reviewer_thread_id = implementation_thread_id then
      raise exception 'reviewer_identity_not_independent' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if old.state <> 'pending' then
    raise exception 'review_attempt_history_immutable' using errcode = '23514';
  end if;
  if new.review_attempt_id is distinct from old.review_attempt_id
    or new.implementation_dispatch_id is distinct from old.implementation_dispatch_id
    or new.reviewer_dispatch_id is distinct from old.reviewer_dispatch_id
    or new.parent_attempt_id is distinct from old.parent_attempt_id
    or new.reviewer_callback_capability_hash is distinct from
      old.reviewer_callback_capability_hash
    or new.repository is distinct from old.repository
    or new.pull_request_number is distinct from old.pull_request_number
    or new.head_sha is distinct from old.head_sha
    or new.base_sha is distinct from old.base_sha
    or new.policy_version is distinct from old.policy_version
    or new.profile is distinct from old.profile
    or new.created_at is distinct from old.created_at then
    raise exception 'review_attempt_subject_immutable' using errcode = '23514';
  end if;
  if old.reviewer_identity is not null and new.reviewer_identity is distinct from
    old.reviewer_identity then
    raise exception 'reviewer_identity_immutable' using errcode = '23514';
  end if;
  if old.reviewer_thread_id is not null and new.reviewer_thread_id is distinct from
    old.reviewer_thread_id then
    raise exception 'reviewer_identity_immutable' using errcode = '23514';
  end if;
  if old.reviewer_turn_id is not null and new.reviewer_turn_id is distinct from
    old.reviewer_turn_id then
    raise exception 'reviewer_identity_immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger enforce_review_attempt_transition_v1
before insert or delete or update on momi_agent_ops.review_attempts
for each row execute function momi_agent_ops.enforce_review_attempt_transition_v1();

create function momi_agent_ops.serialize_dispatch_generation_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || new.linear_issue_id::text, 0));
  return new;
end;
$$;

create trigger serialize_dispatch_generation_v1
before insert on momi_agent_ops.dispatches
for each row when (new.action not in ('cancel-run', 'recover-discovery'))
execute function momi_agent_ops.serialize_dispatch_generation_v1();

create function momi_agent_ops.lock_current_review_subject_v1(
  p_dispatch_id uuid, p_repository text, p_pull_request_number bigint
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare issue_id uuid;
declare current_dispatch_id uuid;
begin
  if p_repository !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    or p_pull_request_number < 1 then return false; end if;
  select work.linear_issue_id into issue_id
  from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.action = ('exec' || 'ute-run');
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || issue_id::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.review_subject:' || p_repository || '#' ||
      p_pull_request_number::text, 0));
  select newest.dispatch_id into current_dispatch_id
  from momi_agent_ops.dispatches newest
  where newest.linear_issue_id = issue_id
    and newest.action not in ('cancel-run', 'recover-discovery')
  order by newest.created_at desc, newest.dispatch_id desc limit 1;
  return current_dispatch_id is not distinct from p_dispatch_id;
end;
$$;

create function momi_agent_ops.current_review_authority_v1(
  p_dispatch_id uuid, p_repository text, p_pull_request_number bigint,
  p_head_sha text, p_base_sha text, p_policy_version text, p_profile text
) returns table (
  review_attempt_id uuid, implementation_dispatch_id uuid,
  reviewer_dispatch_id uuid, repository text, pull_request_number bigint,
  head_sha text, base_sha text, policy_version text, profile text,
  reviewer_identity text, reviewer_thread_id text, reviewer_turn_id text,
  state text, findings jsonb
) language sql stable security invoker set search_path = '' as $$
  select review.review_attempt_id, review.implementation_dispatch_id,
    review.reviewer_dispatch_id, review.repository, review.pull_request_number,
    review.head_sha, review.base_sha, review.policy_version, review.profile,
    review.reviewer_identity, review.reviewer_thread_id,
    review.reviewer_turn_id, review.state, review.findings
  from momi_agent_ops.dispatches work
  join momi_agent_ops.run_records run on run.dispatch_id = work.dispatch_id
  join momi_agent_ops.review_attempts review
    on review.implementation_dispatch_id = work.dispatch_id
  where work.dispatch_id = p_dispatch_id
    and work.action = ('exec' || 'ute-run')
    and work.mapped_repository = p_repository
    and work.work_status in ('writeback_pending', 'active')
    and work.cancellation_requested_at is null and work.cancelled_at is null
    and work.dispatch_id = (select newest.dispatch_id
      from momi_agent_ops.dispatches newest
      where newest.linear_issue_id = work.linear_issue_id
        and newest.action not in ('cancel-run', 'recover-discovery')
      order by newest.created_at desc, newest.dispatch_id desc limit 1)
    and run.pull_request_number = p_pull_request_number
    and run.head_sha = p_head_sha
    and run.validation_state = 'succeeded' and run.validation_sha = p_head_sha
    and review.repository = p_repository
    and review.pull_request_number = p_pull_request_number
    and review.head_sha = p_head_sha and review.base_sha = p_base_sha
    and review.policy_version = p_policy_version and review.profile = p_profile
    and review.state = 'accepted'
    and review.reviewer_identity = 'independent_reviewer'
    and review.reviewer_thread_id is distinct from work.codex_thread_id
    and not jsonb_path_exists(
      review.findings, '$[*] ? (@.severity == "blocking")'
    )
  limit 1;
$$;

create function momi_agent_ops.create_review_attempt_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_repository text, p_pull_request_number bigint, p_head_sha text, p_base_sha text,
  p_policy_version text, p_profile text, p_parent_attempt_id uuid,
  p_reuse_parent_reviewer boolean, p_review_limit integer
) returns table (
  disposition text, review_attempt_id uuid, reviewer_dispatch_id uuid,
  reviewer_callback_capability uuid, reviewer_thread_id text
) language plpgsql security invoker set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
declare run momi_agent_ops.run_records%rowtype;
declare existing momi_agent_ops.review_attempts%rowtype;
declare parent momi_agent_ops.review_attempts%rowtype;
declare callback_capability uuid;
declare active_reviews integer;
declare reviewer_authorized boolean := false;
begin
  if p_head_sha !~ '^[0-9a-f]{40}$' or p_base_sha !~ '^[0-9a-f]{40}$'
    or p_policy_version is null or length(p_policy_version) not between 1 and 120
    or p_profile not in ('low', 'standard', 'high')
    or p_review_limit not between 1 and 32 then
    raise exception 'review_attempt_invalid' using errcode = '22023';
  end if;
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
    and work.mapped_repository = p_repository
    and work.action = ('exec' || 'ute-run')
    and work.work_status in ('writeback_pending', 'active')
    and work.cancellation_requested_at is null and work.cancelled_at is null;
  if not found and p_parent_attempt_id is not null then
    select attempt.* into parent from momi_agent_ops.review_attempts attempt
    where attempt.review_attempt_id = p_parent_attempt_id
      and attempt.implementation_dispatch_id = p_dispatch_id
      and attempt.reviewer_callback_capability_hash = encode(extensions.digest(
        convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
      and attempt.reviewer_thread_id = p_thread_id
      and attempt.reviewer_turn_id = p_turn_id
      and attempt.state = 'failed'
      and attempt.failure_reason = 'escalation_requested'
      and not p_reuse_parent_reviewer
      and p_profile = case attempt.profile when 'low' then 'standard'
        when 'standard' then 'high' else null end;
    reviewer_authorized := found;
    if reviewer_authorized then
      select work.* into selected from momi_agent_ops.dispatches work
      where work.dispatch_id = p_dispatch_id
        and work.mapped_repository = p_repository
        and work.action = ('exec' || 'ute-run')
        and work.work_status in ('writeback_pending', 'active')
        and work.cancellation_requested_at is null and work.cancelled_at is null;
    end if;
  end if;
  if not found then disposition := 'implementation_identity_refused'; return next; return; end if;
  if not momi_agent_ops.lock_current_review_subject_v1(
    p_dispatch_id, p_repository, p_pull_request_number
  ) then disposition := 'current_dispatch_refused'; return next; return; end if;
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and (reviewer_authorized or (
      work.host_callback_token_hash = encode(extensions.digest(
        convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
      and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id))
    and work.mapped_repository = p_repository
    and work.action = ('exec' || 'ute-run')
    and work.work_status in ('writeback_pending', 'active')
    and work.cancellation_requested_at is null and work.cancelled_at is null
  for update;
  if not found then disposition := 'implementation_identity_refused'; return next; return; end if;
  select record.* into run from momi_agent_ops.run_records record
  where record.dispatch_id = p_dispatch_id for update;
  if not found or run.pull_request_number is distinct from p_pull_request_number
    or run.head_sha is distinct from p_head_sha
    or run.validation_state <> 'succeeded' or run.validation_sha <> p_head_sha then
    disposition := 'focused_validation_required'; return next; return;
  end if;
  select attempt.* into existing from momi_agent_ops.review_attempts attempt
  where attempt.implementation_dispatch_id = p_dispatch_id
    and attempt.repository = p_repository
    and attempt.pull_request_number = p_pull_request_number
    and attempt.head_sha = p_head_sha and attempt.base_sha = p_base_sha
    and attempt.policy_version = p_policy_version and attempt.profile = p_profile
    and attempt.state in ('pending', 'accepted')
  order by attempt.created_at desc, attempt.review_attempt_id desc limit 1;
  if found then
    disposition := case existing.state when 'accepted' then 'already_accepted'
      else 'already_pending' end;
    review_attempt_id := existing.review_attempt_id;
    reviewer_dispatch_id := existing.reviewer_dispatch_id;
    return next; return;
  end if;
  if exists (select 1 from momi_agent_ops.review_attempts attempt
    where attempt.implementation_dispatch_id = p_dispatch_id
      and attempt.state = 'pending') then
    disposition := 'pending_subject_conflict'; return next; return;
  end if;
  if p_parent_attempt_id is not null then
    select attempt.* into parent from momi_agent_ops.review_attempts attempt
    where attempt.review_attempt_id = p_parent_attempt_id
      and attempt.implementation_dispatch_id = p_dispatch_id
      and attempt.repository = p_repository
      and attempt.pull_request_number = p_pull_request_number
      and attempt.base_sha = p_base_sha
      and attempt.policy_version = p_policy_version
      and attempt.state in ('changes_requested', 'failed');
    if not found then disposition := 'parent_attempt_refused'; return next; return; end if;
    if p_reuse_parent_reviewer then
      if parent.state <> 'changes_requested' or parent.profile <> p_profile
        or parent.reviewer_identity <> 'independent_reviewer'
        or parent.reviewer_thread_id is null then
        disposition := 'parent_reviewer_refused'; return next; return;
      end if;
      reviewer_thread_id := parent.reviewer_thread_id;
    end if;
  elsif p_reuse_parent_reviewer then
    disposition := 'parent_reviewer_refused'; return next; return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.review_capacity', 0));
  select count(*)::integer into active_reviews
  from momi_agent_ops.review_attempts attempt where attempt.state = 'pending';
  if active_reviews >= p_review_limit then
    disposition := 'capacity_wait'; return next; return;
  end if;
  callback_capability := gen_random_uuid();
  insert into momi_agent_ops.review_attempts (
    implementation_dispatch_id, parent_attempt_id,
    reviewer_callback_capability_hash, repository, pull_request_number,
    head_sha, base_sha, policy_version, profile
  ) values (
    p_dispatch_id, p_parent_attempt_id,
    encode(extensions.digest(convert_to(callback_capability::text, 'UTF8'), 'sha256'), 'hex'),
    p_repository, p_pull_request_number, p_head_sha, p_base_sha,
    p_policy_version, p_profile
  ) returning review_attempts.review_attempt_id, review_attempts.reviewer_dispatch_id
    into review_attempt_id, reviewer_dispatch_id;
  disposition := 'created';
  reviewer_callback_capability := callback_capability;
  return next;
end;
$$;

create function momi_agent_ops.record_reviewer_start_v1(
  p_reviewer_dispatch_id uuid, p_callback_capability uuid,
  p_reviewer_identity text, p_thread_id text, p_turn_id text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare attempt momi_agent_ops.review_attempts%rowtype;
begin
  select review.* into attempt from momi_agent_ops.review_attempts review
  where review.reviewer_dispatch_id = p_reviewer_dispatch_id
    and review.reviewer_callback_capability_hash = encode(extensions.digest(
      convert_to(p_callback_capability::text, 'UTF8'), 'sha256'), 'hex');
  if not found or attempt.state <> 'pending'
    or p_reviewer_identity <> 'independent_reviewer' then return false; end if;
  if not momi_agent_ops.lock_current_review_subject_v1(
    attempt.implementation_dispatch_id, attempt.repository,
    attempt.pull_request_number
  ) then return false; end if;
  update momi_agent_ops.review_attempts review set
    reviewer_identity = p_reviewer_identity, reviewer_thread_id = p_thread_id,
    reviewer_turn_id = p_turn_id, started_at = coalesce(review.started_at, now()),
    updated_at = now()
  where review.review_attempt_id = attempt.review_attempt_id
    and review.state = 'pending' and review.reviewer_identity is null
    and review.reviewer_thread_id is null and review.reviewer_turn_id is null;
  return found;
end;
$$;

create function momi_agent_ops.record_review_failure_v1(
  p_reviewer_dispatch_id uuid, p_callback_capability uuid, p_reason text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_reason is null or length(p_reason) not between 1 and 500 then return false; end if;
  update momi_agent_ops.review_attempts review set state = 'failed',
    failure_reason = p_reason, terminal_at = now(), updated_at = now()
  where review.reviewer_dispatch_id = p_reviewer_dispatch_id
    and review.reviewer_callback_capability_hash = encode(extensions.digest(
      convert_to(p_callback_capability::text, 'UTF8'), 'sha256'), 'hex')
    and review.state = 'pending';
  return found;
end;
$$;

create function momi_agent_ops.record_review_result_v1(
  p_reviewer_dispatch_id uuid, p_callback_capability uuid,
  p_thread_id text, p_turn_id text, p_repository text,
  p_pull_request_number bigint, p_head_sha text, p_base_sha text,
  p_policy_version text, p_profile text, p_result text, p_findings jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare attempt momi_agent_ops.review_attempts%rowtype;
declare next_state text;
declare reason text;
begin
  if p_result not in ('accepted', 'changes_requested', 'inconclusive', 'escalate')
    or p_findings is null or jsonb_typeof(p_findings) <> 'array'
    or pg_column_size(p_findings) > 65536 then return false; end if;
  if p_result = 'accepted' and jsonb_path_exists(
    p_findings, '$[*] ? (@.severity == "blocking")'
  ) then return false; end if;
  select review.* into attempt from momi_agent_ops.review_attempts review
  where review.reviewer_dispatch_id = p_reviewer_dispatch_id
    and review.reviewer_callback_capability_hash = encode(extensions.digest(
      convert_to(p_callback_capability::text, 'UTF8'), 'sha256'), 'hex');
  if not found or attempt.state <> 'pending' then return false; end if;
  if not momi_agent_ops.lock_current_review_subject_v1(
    attempt.implementation_dispatch_id, p_repository, p_pull_request_number
  ) then return false; end if;
  if attempt.repository is distinct from p_repository
    or attempt.pull_request_number is distinct from p_pull_request_number
    or attempt.head_sha is distinct from p_head_sha
    or attempt.base_sha is distinct from p_base_sha
    or attempt.policy_version is distinct from p_policy_version
    or attempt.profile is distinct from p_profile
    or attempt.reviewer_identity <> 'independent_reviewer'
    or attempt.reviewer_thread_id is distinct from p_thread_id
    or attempt.reviewer_turn_id is distinct from p_turn_id then return false; end if;
  if not exists (select 1 from momi_agent_ops.dispatches work
    join momi_agent_ops.run_records run on run.dispatch_id = work.dispatch_id
    where work.dispatch_id = attempt.implementation_dispatch_id
      and work.work_status in ('writeback_pending', 'active')
      and work.cancellation_requested_at is null and work.cancelled_at is null
      and run.pull_request_number = p_pull_request_number
      and run.head_sha = p_head_sha
      and run.validation_state = 'succeeded' and run.validation_sha = p_head_sha
  ) then return false; end if;
  next_state := case p_result when 'accepted' then 'accepted'
    when 'changes_requested' then 'changes_requested' else 'failed' end;
  reason := case p_result when 'inconclusive' then 'inconclusive'
    when 'escalate' then 'escalation_requested' else null end;
  update momi_agent_ops.review_attempts review set state = next_state,
    findings = p_findings, failure_reason = reason, terminal_at = now(), updated_at = now()
  where review.review_attempt_id = attempt.review_attempt_id and review.state = 'pending';
  return found;
end;
$$;

create function momi_agent_ops.get_review_status_v1(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text
) returns table (
  review_attempt_id uuid, parent_attempt_id uuid, state text, findings jsonb,
  failure_reason text, reviewer_dispatch_id uuid, reviewer_thread_id text,
  head_sha text, base_sha text, profile text, policy_version text
) language sql stable security invoker set search_path = '' as $$
  select review.review_attempt_id, review.parent_attempt_id, review.state,
    review.findings, review.failure_reason, review.reviewer_dispatch_id,
    review.reviewer_thread_id, review.head_sha, review.base_sha,
    review.profile, review.policy_version
  from momi_agent_ops.dispatches work
  join momi_agent_ops.review_attempts review
    on review.implementation_dispatch_id = work.dispatch_id
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
  order by review.created_at desc, review.review_attempt_id desc limit 1;
$$;

create function momi_agent_ops.record_lifecycle_evidence_v3(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_repository text, p_base_branch text, p_branch_name text,
  p_pull_request_number bigint, p_phase text, p_status text,
  p_previous_revision_sha text, p_revision_sha text, p_merge_sha text,
  p_workflow_run_id text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
declare current_run momi_agent_ops.run_records%rowtype;
begin
  if p_phase = 'reviewing' then return false; end if;
  if p_phase not in ('validating', 'releasing') then
    raise exception 'lifecycle_evidence_invalid' using errcode = '22023';
  end if;
  if p_previous_revision_sha is not null
    and p_previous_revision_sha !~ '^[0-9a-f]{40}$' then
    raise exception 'lifecycle_evidence_invalid' using errcode = '22023';
  end if;
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
    and work.mapped_repository = p_repository and work.mapped_base_branch = p_base_branch
    and work.action = ('exec' || 'ute-run')
    and work.cancellation_requested_at is null and work.cancelled_at is null;
  if not found then return false; end if;
  if not momi_agent_ops.lock_current_review_subject_v1(
    p_dispatch_id, p_repository, p_pull_request_number
  ) then return false; end if;
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
    and work.mapped_repository = p_repository and work.mapped_base_branch = p_base_branch
    and work.action = ('exec' || 'ute-run')
    and work.cancellation_requested_at is null and work.cancelled_at is null
  for update;
  if not found then return false; end if;
  select run.* into current_run from momi_agent_ops.run_records run
  where run.dispatch_id = p_dispatch_id for update;
  if current_run.branch_name is distinct from p_branch_name
    and current_run.branch_name is not null then return false; end if;
  if current_run.pull_request_number is distinct from p_pull_request_number
    and current_run.pull_request_number is not null then return false; end if;
  if p_phase = 'validating'
    and current_run.head_sha is distinct from p_revision_sha then
    if current_run.head_sha is distinct from p_previous_revision_sha then return false; end if;
    if p_status not in ('pending', 'running', 'succeeded', 'failed')
      or p_revision_sha !~ '^[0-9a-f]{40}$' then
      raise exception 'lifecycle_evidence_invalid' using errcode = '22023';
    end if;
    update momi_agent_ops.review_attempts review set state = 'canceled',
      terminal_at = now(), updated_at = now()
    where review.implementation_dispatch_id = p_dispatch_id
      and review.state = 'pending';
    update momi_agent_ops.run_records run set
      branch_name = p_branch_name, pull_request_number = p_pull_request_number,
      head_sha = p_revision_sha, validation_state = p_status,
      validation_sha = p_revision_sha, validation_workflow_run_id = p_workflow_run_id,
      updated_at = now()
    where run.dispatch_id = p_dispatch_id;
    return found;
  end if;
  return momi_agent_ops.record_lifecycle_evidence_v2(
    p_dispatch_id, p_capability_token, p_thread_id, p_turn_id,
    p_repository, p_base_branch, p_branch_name, p_pull_request_number,
    p_phase, p_status, p_revision_sha, p_merge_sha, p_workflow_run_id
  );
end;
$$;

create function momi_agent_ops.reconstruct_cancellation_targets_v1(
  p_dispatch_id uuid, p_capability_token uuid
) returns uuid[] language plpgsql security invoker set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
declare issue_id uuid;
declare repository text;
declare pull_request_number bigint;
declare targets uuid[];
begin
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id and work.action = 'cancel-run'
    and work.target_dispatch_id is not null
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.work_status in ('claimed', 'writeback_pending');
  if not found then return '{}'::uuid[]; end if;
  select target.linear_issue_id, target.mapped_repository, run.pull_request_number
  into issue_id, repository, pull_request_number
  from momi_agent_ops.dispatches target
  join momi_agent_ops.run_records run on run.dispatch_id = target.dispatch_id
  where target.dispatch_id = selected.target_dispatch_id;
  if not found then return '{}'::uuid[]; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || issue_id::text, 0));
  if repository is not null and pull_request_number is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'momi_agent_ops.review_subject:' || repository || '#' ||
        pull_request_number::text, 0));
  end if;
  with recursive lifecycle as (
    select selected.target_dispatch_id as dispatch_id
    union all
    select child.dispatch_id from momi_agent_ops.dispatches child
    join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
    where child.action = ('exec' || 'ute-run')
  ), cancellation_targets as (
    select work.dispatch_id from lifecycle owned
    join momi_agent_ops.dispatches work on work.dispatch_id = owned.dispatch_id
    where work.work_status in ('claimed', 'writeback_pending', 'active')
      and work.codex_thread_id is not null and work.codex_turn_id is not null
    union
    select review.reviewer_dispatch_id from lifecycle owned
    join momi_agent_ops.review_attempts review
      on review.implementation_dispatch_id = owned.dispatch_id
    where review.state = 'pending'
  )
  select coalesce(array_agg(target.dispatch_id order by target.dispatch_id), '{}'::uuid[])
  into targets from cancellation_targets target;
  return targets;
end;
$$;

create function momi_agent_ops.fence_cancellation_v1(
  p_dispatch_id uuid, p_capability_token uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
declare issue_id uuid;
declare repository text;
declare pull_request_number bigint;
begin
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id and work.action = 'cancel-run'
    and work.target_dispatch_id is not null
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.work_status in ('claimed', 'writeback_pending');
  if not found then return false; end if;
  select target.linear_issue_id, target.mapped_repository, run.pull_request_number
  into issue_id, repository, pull_request_number
  from momi_agent_ops.dispatches target
  join momi_agent_ops.run_records run on run.dispatch_id = target.dispatch_id
  where target.dispatch_id = selected.target_dispatch_id;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || issue_id::text, 0));
  if repository is not null and pull_request_number is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'momi_agent_ops.review_subject:' || repository || '#' ||
        pull_request_number::text, 0));
  end if;
  with recursive lifecycle as (
    select selected.target_dispatch_id as dispatch_id
    union all
    select child.dispatch_id from momi_agent_ops.dispatches child
    join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
    where child.action = ('exec' || 'ute-run')
  )
  update momi_agent_ops.review_attempts review set
    state = 'canceled', terminal_at = now(), updated_at = now()
  where review.implementation_dispatch_id in (select dispatch_id from lifecycle)
    and review.state = 'pending';
  with recursive lifecycle as (
    select selected.target_dispatch_id as dispatch_id
    union all
    select child.dispatch_id from momi_agent_ops.dispatches child
    join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
    where child.action = ('exec' || 'ute-run')
  )
  update momi_agent_ops.dispatches work set
    cancellation_requested_at = coalesce(work.cancellation_requested_at, now()),
    work_status = case when work.work_status = 'pending' then 'cancelled'
      else work.work_status end,
    cancelled_at = case when work.work_status = 'pending'
      then coalesce(work.cancelled_at, now()) else work.cancelled_at end
  where work.dispatch_id in (select dispatch_id from lifecycle)
    and work.work_status not in ('completed', 'cancelled', 'rejected', 'dead_letter');
  return true;
end;
$$;

create function momi_agent_ops.record_cancellation_v3(
  p_dispatch_id uuid, p_capability_token uuid, p_cancellation_state text
) returns boolean language sql security invoker set search_path = '' as $$
  select momi_agent_ops.record_cancellation_v2(
    p_dispatch_id, p_capability_token, p_cancellation_state
  );
$$;

create function momi_agent_ops.record_terminal_v5(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_readiness_result text, p_terminal_disposition text,
  p_terminal_summary text, p_archived_at timestamptz, p_telemetry jsonb
) returns table (
  issue_id uuid, issue_identifier text, action text, linear_comment_id uuid
) language plpgsql security invoker set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
declare current_run momi_agent_ops.run_records%rowtype;
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
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id;
  if not found then return; end if;
  if p_readiness_result = 'ready' and p_terminal_disposition = 'completed' then
    select run.* into current_run from momi_agent_ops.run_records run
    where run.dispatch_id = p_dispatch_id;
    if current_run.pull_request_number is not null then
      if not momi_agent_ops.lock_current_review_subject_v1(
        p_dispatch_id, selected.mapped_repository, current_run.pull_request_number
      ) then return; end if;
      select run.* into current_run from momi_agent_ops.run_records run
      where run.dispatch_id = p_dispatch_id for update;
      if current_run.validation_state <> 'succeeded'
        or current_run.validation_sha is distinct from current_run.head_sha
        or current_run.merge_sha is null
        or current_run.release_state <> 'succeeded'
        or current_run.release_sha is distinct from current_run.merge_sha
        or not exists (
          select 1 from momi_agent_ops.review_attempts review
          where review.implementation_dispatch_id = p_dispatch_id
            and review.repository = selected.mapped_repository
            and review.pull_request_number = current_run.pull_request_number
            and review.head_sha = current_run.head_sha
            and review.state = 'accepted'
            and not exists (select 1 from jsonb_array_elements(review.findings) finding
              where finding->>'severity' = 'blocking')
        ) then return; end if;
    end if;
  end if;
  return query select terminal.issue_id, terminal.issue_identifier,
    terminal.action, terminal.linear_comment_id
  from momi_agent_ops.record_terminal_v4(
    p_dispatch_id, p_capability_token, p_thread_id, p_turn_id,
    p_readiness_result, p_terminal_disposition, p_terminal_summary,
    p_archived_at, p_telemetry
  ) terminal;
end;
$$;

alter table momi_agent_ops.review_attempts enable row level security;
revoke all on table momi_agent_ops.review_attempts
  from public, anon, authenticated, service_role;
revoke all on function momi_agent_ops.enforce_review_attempt_transition_v1()
  from public, anon, authenticated, service_role;
revoke all on function momi_agent_ops.serialize_dispatch_generation_v1(),
  momi_agent_ops.lock_current_review_subject_v1(uuid, text, bigint),
  momi_agent_ops.current_review_authority_v1(
    uuid, text, bigint, text, text, text, text
  ),
  momi_agent_ops.create_review_attempt_v1(
    uuid, uuid, text, text, text, bigint, text, text, text, text,
    uuid, boolean, integer
  ),
  momi_agent_ops.record_reviewer_start_v1(uuid, uuid, text, text, text),
  momi_agent_ops.record_review_failure_v1(uuid, uuid, text),
  momi_agent_ops.record_review_result_v1(
    uuid, uuid, text, text, text, bigint, text, text, text, text, text, jsonb
  ),
  momi_agent_ops.get_review_status_v1(uuid, uuid, text, text),
  momi_agent_ops.record_lifecycle_evidence_v3(
    uuid, uuid, text, text, text, text, text, bigint, text, text,
    text, text, text, text
  ),
  momi_agent_ops.reconstruct_cancellation_targets_v1(uuid, uuid),
  momi_agent_ops.fence_cancellation_v1(uuid, uuid),
  momi_agent_ops.record_cancellation_v3(uuid, uuid, text),
  momi_agent_ops.record_terminal_v5(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb
  ) from public, anon, authenticated, service_role;
