-- service-owner: agent-control

alter table momi_agent_ops.run_records
  drop constraint run_records_review_state_check,
  add constraint run_records_review_state_check check (
    review_state in ('not_required', 'pending', 'running', 'succeeded', 'failed',
      'changes_requested', 'inconclusive')
  ),
  add column review_base_sha text check (
    review_base_sha is null or review_base_sha ~ '^[0-9a-f]{40}$'
  ),
  add column review_policy_version text check (
    review_policy_version is null or length(review_policy_version) between 1 and 120
  ),
  add column review_profile text check (
    review_profile is null or review_profile in ('low', 'standard', 'high')
  ),
  add column review_receipt_id uuid,
  add column review_check_sha text check (
    review_check_sha is null or review_check_sha ~ '^[0-9a-f]{40}$'
  ),
  add column merge_preflight_sha text check (
    merge_preflight_sha is null or merge_preflight_sha ~ '^[0-9a-f]{40}$'
  ),
  add column merge_preflight_base_sha text check (
    merge_preflight_base_sha is null or merge_preflight_base_sha ~ '^[0-9a-f]{40}$'
  ),
  add column merge_preflight_review_receipt_id uuid,
  add column merge_preflight_at timestamptz;

create table momi_agent_ops.review_attempts (
  review_attempt_id uuid primary key default gen_random_uuid(),
  implementation_dispatch_id uuid not null references momi_agent_ops.dispatches(dispatch_id),
  reviewer_dispatch_id uuid not null unique default gen_random_uuid(),
  reverification_of uuid references momi_agent_ops.review_attempts(review_attempt_id),
  escalation_of uuid references momi_agent_ops.review_attempts(review_attempt_id),
  escalation_depth integer not null default 0 check (escalation_depth between 0 and 2),
  generation integer not null check (generation > 0),
  repository text not null check (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  base_branch text not null check (base_branch ~ '^[A-Za-z0-9._/-]+$'),
  pull_request_number bigint not null check (pull_request_number > 0),
  head_sha text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  profile text not null check (profile in ('low', 'standard', 'high')),
  review_model text not null,
  reasoning_effort text not null,
  budget_fingerprint text not null check (budget_fingerprint ~ '^fnv1a64:[0-9a-f]{16}$'),
  check ((profile, review_model, reasoning_effort, budget_fingerprint) in (
    ('low', 'gpt-5.6-luna', 'low', 'fnv1a64:9ede9fa30f041ad1'),
    ('standard', 'gpt-5.6-terra', 'medium', 'fnv1a64:9631b8b9d5daf636'),
    ('high', 'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a')
  )),
  policy_version text not null check (length(policy_version) between 1 and 120),
  state text not null default 'reserved' check (state in (
    'reserved', 'running', 'accepted', 'changes_requested', 'inconclusive',
    'escalated', 'failed', 'stale', 'superseded', 'canceled', 'ambiguous'
  )),
  runtime_role text check (runtime_role is null or runtime_role = 'independent_reviewer'),
  reviewer_capability_token_hash text not null check (
    reviewer_capability_token_hash ~ '^[0-9a-f]{64}$'
  ),
  reviewer_thread_id text,
  reviewer_turn_id text,
  packet_fingerprint text not null check (packet_fingerprint ~ '^fnv1a64:[0-9a-f]{16}$'),
  packet_artifact_ref text not null check (length(packet_artifact_ref) between 1 and 500),
  rules_fingerprint text not null check (rules_fingerprint ~ '^fnv1a64:[0-9a-f]{16}$'),
  risk_dimensions text[] not null check (cardinality(risk_dimensions) between 1 and 16),
  correction_risk_dimensions text[] not null check (
    cardinality(correction_risk_dimensions) between 1 and 16
  ),
  result text check (result is null or result in (
    'accepted', 'changes_requested', 'inconclusive', 'escalate'
  )),
  findings jsonb not null default '[]'::jsonb check (
    jsonb_typeof(findings) = 'array' and pg_column_size(findings) <= 65536
  ),
  blocking_finding_count integer not null default 0 check (blocking_finding_count >= 0),
  nonblocking_finding_count integer not null default 0 check (nonblocking_finding_count >= 0),
  result_fingerprint text check (
    result_fingerprint is null or result_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  result_artifact_ref text check (
    result_artifact_ref is null or length(result_artifact_ref) between 1 and 500
  ),
  telemetry jsonb check (
    telemetry is null or (jsonb_typeof(telemetry) = 'object' and pg_column_size(telemetry) <= 16384)
  ),
  started_at timestamptz,
  terminal_at timestamptz,
  stale_at timestamptz,
  canceled_at timestamptz,
  interruption_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (implementation_dispatch_id, generation)
);

alter table momi_agent_ops.run_records add constraint run_records_review_receipt_fk
  foreign key (review_receipt_id) references momi_agent_ops.review_attempts(review_attempt_id);
alter table momi_agent_ops.run_records add constraint run_records_merge_preflight_receipt_fk
  foreign key (merge_preflight_review_receipt_id)
  references momi_agent_ops.review_attempts(review_attempt_id);

create unique index review_attempts_one_active_idx
  on momi_agent_ops.review_attempts (implementation_dispatch_id)
  where state in ('reserved', 'running');
create index review_attempts_capacity_idx on momi_agent_ops.review_attempts (state, created_at)
  where state in ('reserved', 'running');
create unique index review_attempts_one_escalation_idx
  on momi_agent_ops.review_attempts (escalation_of) where escalation_of is not null;

alter table momi_agent_ops.review_attempts enable row level security;
revoke all on table momi_agent_ops.review_attempts
  from public, anon, authenticated, service_role;

create function momi_agent_ops.create_review_attempt_v1(
  p_dispatch_id uuid,
  p_capability_token uuid,
  p_thread_id text,
  p_turn_id text,
  p_repository text,
  p_base_branch text,
  p_pull_request_number bigint,
  p_head_sha text,
  p_base_sha text,
  p_profile text,
  p_policy_version text,
  p_packet_fingerprint text,
  p_packet_artifact_ref text,
  p_rules_fingerprint text,
  p_risk_dimensions text[],
  p_correction_risk_dimensions text[],
  p_reverification_of uuid,
  p_review_limit integer
) returns table (
  disposition text, review_attempt_id uuid, reviewer_dispatch_id uuid,
  reviewer_capability_token uuid, generation integer, reviewer_thread_id text
) language plpgsql security invoker set search_path = '' as $$
declare
  selected momi_agent_ops.dispatches%rowtype;
  run momi_agent_ops.run_records%rowtype;
  prior momi_agent_ops.review_attempts%rowtype;
  prior_reviewer momi_agent_ops.review_attempts%rowtype;
  token uuid;
  next_generation integer;
  active_reviews integer;
begin
  if p_profile not in ('low', 'standard', 'high')
    or p_policy_version is null or length(p_policy_version) not between 1 and 120
    or p_repository !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    or p_base_branch !~ '^[A-Za-z0-9._/-]+$' or p_pull_request_number < 1
    or p_head_sha !~ '^[0-9a-f]{40}$' or p_base_sha !~ '^[0-9a-f]{40}$'
    or p_packet_fingerprint !~ '^fnv1a64:[0-9a-f]{16}$'
    or p_rules_fingerprint !~ '^fnv1a64:[0-9a-f]{16}$'
    or cardinality(p_risk_dimensions) not between 1 and 16
    or cardinality(p_correction_risk_dimensions) not between 1 and 16
    or length(p_packet_artifact_ref) not between 1 and 500
    or p_review_limit not between 1 and 32 then
    raise exception 'review_attempt_invalid' using errcode = '22023';
  end if;
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id and work.action = ('exec' || 'ute-run')
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
    and work.mapped_repository = p_repository and work.mapped_base_branch = p_base_branch
    and work.work_status in ('writeback_pending', 'active')
    and work.cancellation_requested_at is null and work.cancelled_at is null
  for update;
  if not found then disposition := 'implementation_identity_refused'; return next; return; end if;
  select record.* into run from momi_agent_ops.run_records record
  where record.dispatch_id = p_dispatch_id for update;
  if run.validation_state <> 'succeeded' or run.validation_sha <> p_head_sha
    or run.head_sha <> p_head_sha then
    disposition := 'focused_validation_required'; return next; return;
  end if;
  select attempt.* into prior from momi_agent_ops.review_attempts attempt
  where attempt.implementation_dispatch_id = p_dispatch_id
    and attempt.repository = p_repository and attempt.pull_request_number = p_pull_request_number
    and attempt.head_sha = p_head_sha and attempt.base_sha = p_base_sha
    and attempt.profile = p_profile and attempt.policy_version = p_policy_version
  order by attempt.generation desc limit 1;
  if found then
    review_attempt_id := prior.review_attempt_id;
    reviewer_dispatch_id := prior.reviewer_dispatch_id;
    generation := prior.generation;
    if prior.reverification_of is not null then
      select source.* into prior_reviewer from momi_agent_ops.review_attempts source
      where source.review_attempt_id = prior.reverification_of;
      reviewer_thread_id := prior_reviewer.reviewer_thread_id;
    end if;
    if prior.state = 'accepted' then
      disposition := 'already_accepted'; return next; return;
    elsif prior.state = 'running' then
      disposition := 'already_running'; return next; return;
    elsif prior.state = 'changes_requested' then
      disposition := 'changes_requested'; return next; return;
    elsif prior.state = 'reserved' then
      token := gen_random_uuid();
      update momi_agent_ops.review_attempts attempt set
        reviewer_capability_token_hash = encode(extensions.digest(
          convert_to(token::text, 'UTF8'), 'sha256'), 'hex'), updated_at = now()
      where attempt.review_attempt_id = prior.review_attempt_id;
      disposition := 'created'; reviewer_capability_token := token;
      return next; return;
    end if;
  end if;
  update momi_agent_ops.review_attempts attempt set state = 'stale', stale_at = now(),
    updated_at = now() where attempt.implementation_dispatch_id = p_dispatch_id
    and attempt.state = 'accepted';
  update momi_agent_ops.review_attempts attempt set state = 'superseded', terminal_at = now(),
    updated_at = now() where attempt.implementation_dispatch_id = p_dispatch_id
    and attempt.state in ('reserved', 'running');
  if exists (select 1 from momi_agent_ops.review_attempts attempt
    where attempt.implementation_dispatch_id = p_dispatch_id
      and attempt.state = 'superseded' and attempt.reviewer_thread_id is not null
      and attempt.interruption_confirmed_at is null) then
    review_attempt_id := null; reviewer_dispatch_id := null;
    reviewer_capability_token := null; generation := null; reviewer_thread_id := null;
    disposition := 'reviewer_interruption_pending'; return next; return;
  end if;
  select count(*) into active_reviews from momi_agent_ops.review_attempts attempt
  where attempt.state in ('reserved', 'running');
  if active_reviews >= p_review_limit then
    review_attempt_id := null; reviewer_dispatch_id := null;
    reviewer_capability_token := null; generation := null; reviewer_thread_id := null;
    disposition := 'capacity_wait'; return next; return;
  end if;
  select coalesce(max(attempt.generation), 0) + 1 into next_generation
  from momi_agent_ops.review_attempts attempt
  where attempt.implementation_dispatch_id = p_dispatch_id;
  if p_reverification_of is not null then
    select source.* into prior_reviewer from momi_agent_ops.review_attempts source
    where source.review_attempt_id = p_reverification_of
      and source.implementation_dispatch_id = p_dispatch_id
      and source.state = 'changes_requested'
      and source.reviewer_thread_id is not null
      and source.profile = p_profile and source.policy_version = p_policy_version
      and source.repository = p_repository
      and source.pull_request_number = p_pull_request_number
      and source.base_sha = p_base_sha
      and source.rules_fingerprint = p_rules_fingerprint
      and source.head_sha <> p_head_sha;
    if not found then
      review_attempt_id := null; reviewer_dispatch_id := null;
      reviewer_capability_token := null; generation := null; reviewer_thread_id := null;
      disposition := 'reverification_refused'; return next; return;
    end if;
    reviewer_thread_id := prior_reviewer.reviewer_thread_id;
  end if;
  token := gen_random_uuid();
  insert into momi_agent_ops.review_attempts (
    implementation_dispatch_id, reverification_of, generation, repository, base_branch, pull_request_number,
    head_sha, base_sha, profile, review_model, reasoning_effort, budget_fingerprint,
    policy_version,
    reviewer_capability_token_hash,
    packet_fingerprint, packet_artifact_ref, rules_fingerprint,
    risk_dimensions, correction_risk_dimensions
  ) values (
    p_dispatch_id, p_reverification_of, next_generation, p_repository, p_base_branch, p_pull_request_number,
    p_head_sha, p_base_sha, p_profile,
    case p_profile when 'low' then 'gpt-5.6-luna'
      when 'standard' then 'gpt-5.6-terra' else 'gpt-5.6-sol' end,
    case p_profile when 'low' then 'low'
      when 'standard' then 'medium' else 'high' end,
    case p_profile when 'low' then 'fnv1a64:9ede9fa30f041ad1'
      when 'standard' then 'fnv1a64:9631b8b9d5daf636'
      else 'fnv1a64:0b9ef0157af3f30a' end,
    p_policy_version,
    encode(extensions.digest(convert_to(token::text, 'UTF8'), 'sha256'), 'hex'),
    p_packet_fingerprint, p_packet_artifact_ref, p_rules_fingerprint,
    p_risk_dimensions, p_correction_risk_dimensions
  ) returning review_attempts.review_attempt_id, review_attempts.reviewer_dispatch_id
    into review_attempt_id, reviewer_dispatch_id;
  update momi_agent_ops.run_records record set review_state = 'pending',
    review_sha = p_head_sha, review_base_sha = p_base_sha,
    review_policy_version = p_policy_version, review_profile = p_profile,
    review_receipt_id = null, review_check_sha = null, updated_at = now()
  where record.dispatch_id = p_dispatch_id;
  disposition := 'created'; reviewer_capability_token := token;
  generation := next_generation; return next;
end;
$$;

create function momi_agent_ops.create_escalated_review_attempt_v1(
  p_reviewer_dispatch_id uuid,
  p_capability_token uuid,
  p_thread_id text,
  p_turn_id text,
  p_packet_fingerprint text,
  p_packet_artifact_ref text,
  p_rules_fingerprint text,
  p_risk_dimensions text[],
  p_review_limit integer
) returns table (
  disposition text, review_attempt_id uuid, reviewer_dispatch_id uuid,
  reviewer_capability_token uuid, generation integer, profile text
) language plpgsql security invoker set search_path = '' as $$
declare
  source momi_agent_ops.review_attempts%rowtype;
  child momi_agent_ops.review_attempts%rowtype;
  token uuid;
  next_generation integer;
  next_profile text;
  active_reviews integer;
begin
  if p_packet_fingerprint !~ '^fnv1a64:[0-9a-f]{16}$'
    or length(p_packet_artifact_ref) not between 1 and 500
    or p_rules_fingerprint !~ '^fnv1a64:[0-9a-f]{16}$'
    or cardinality(p_risk_dimensions) not between 1 and 16
    or p_review_limit not between 1 and 32 then
    raise exception 'review_escalation_invalid' using errcode = '22023';
  end if;
  select attempt.* into source from momi_agent_ops.review_attempts attempt
  where attempt.reviewer_dispatch_id = p_reviewer_dispatch_id
    and attempt.reviewer_capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and attempt.runtime_role = 'independent_reviewer'
    and attempt.reviewer_thread_id = p_thread_id and attempt.reviewer_turn_id = p_turn_id
    and (attempt.state = 'escalated' or
      (attempt.state = 'failed' and attempt.profile = 'high'))
    and attempt.result = 'escalate'
  for update;
  if not found then disposition := 'escalation_identity_refused'; return next; return; end if;
  select attempt.* into child from momi_agent_ops.review_attempts attempt
  where attempt.escalation_of = source.review_attempt_id;
  if found then
    review_attempt_id := child.review_attempt_id;
    reviewer_dispatch_id := child.reviewer_dispatch_id;
    generation := child.generation;
    profile := child.profile;
    if child.state = 'reserved' then
      token := gen_random_uuid();
      update momi_agent_ops.review_attempts attempt set
        reviewer_capability_token_hash = encode(extensions.digest(
          convert_to(token::text, 'UTF8'), 'sha256'), 'hex'), updated_at = now()
      where attempt.review_attempt_id = child.review_attempt_id;
      disposition := 'created'; reviewer_capability_token := token;
    else
      disposition := 'already_' || child.state;
    end if;
    return next; return;
  end if;
  next_profile := case source.profile when 'low' then 'standard'
    when 'standard' then 'high' else null end;
  if next_profile is null or source.escalation_depth >= 2 then
    update momi_agent_ops.review_attempts attempt set state = 'failed', updated_at = now()
    where attempt.review_attempt_id = source.review_attempt_id;
    update momi_agent_ops.run_records run set review_state = 'failed',
      review_receipt_id = null, review_check_sha = null, updated_at = now()
    where run.dispatch_id = source.implementation_dispatch_id;
    disposition := 'escalation_exhausted'; review_attempt_id := source.review_attempt_id;
    reviewer_dispatch_id := source.reviewer_dispatch_id;
    generation := source.generation; profile := source.profile;
    return next; return;
  end if;
  select count(*) into active_reviews from momi_agent_ops.review_attempts attempt
  where attempt.state in ('reserved', 'running');
  if active_reviews >= p_review_limit then
    disposition := 'capacity_wait'; profile := next_profile; return next; return;
  end if;
  select coalesce(max(attempt.generation), 0) + 1 into next_generation
  from momi_agent_ops.review_attempts attempt
  where attempt.implementation_dispatch_id = source.implementation_dispatch_id;
  token := gen_random_uuid();
  insert into momi_agent_ops.review_attempts (
    implementation_dispatch_id, escalation_of, escalation_depth, generation,
    repository, base_branch, pull_request_number, head_sha, base_sha, profile,
    review_model, reasoning_effort, budget_fingerprint, policy_version,
    reviewer_capability_token_hash,
    packet_fingerprint,
    packet_artifact_ref, rules_fingerprint, risk_dimensions, correction_risk_dimensions
  ) values (
    source.implementation_dispatch_id, source.review_attempt_id, source.escalation_depth + 1,
    next_generation, source.repository, source.base_branch, source.pull_request_number,
    source.head_sha, source.base_sha, next_profile,
    case next_profile when 'standard' then 'gpt-5.6-terra' else 'gpt-5.6-sol' end,
    case next_profile when 'standard' then 'medium' else 'high' end,
    case next_profile when 'standard' then 'fnv1a64:9631b8b9d5daf636'
      else 'fnv1a64:0b9ef0157af3f30a' end,
    source.policy_version,
    encode(extensions.digest(convert_to(token::text, 'UTF8'), 'sha256'), 'hex'),
    p_packet_fingerprint, p_packet_artifact_ref, p_rules_fingerprint,
    p_risk_dimensions, p_risk_dimensions
  ) returning review_attempts.review_attempt_id, review_attempts.reviewer_dispatch_id
    into review_attempt_id, reviewer_dispatch_id;
  update momi_agent_ops.run_records run set review_state = 'pending',
    review_sha = source.head_sha, review_base_sha = source.base_sha,
    review_policy_version = source.policy_version, review_profile = next_profile,
    review_receipt_id = null, review_check_sha = null, updated_at = now()
  where run.dispatch_id = source.implementation_dispatch_id;
  disposition := 'created'; reviewer_capability_token := token;
  generation := next_generation; profile := next_profile; return next;
end;
$$;

create function momi_agent_ops.record_reviewer_start_v1(
  p_reviewer_dispatch_id uuid,
  p_capability_token uuid,
  p_runtime_role text,
  p_thread_id text,
  p_turn_id text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare attempt momi_agent_ops.review_attempts%rowtype;
declare implementation_thread text;
declare implementation_canceled boolean;
begin
  select review.* into attempt from momi_agent_ops.review_attempts review
  where review.reviewer_dispatch_id = p_reviewer_dispatch_id
    and review.reviewer_capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and (review.state = 'reserved' or (review.state in ('canceled', 'superseded')
      and review.reviewer_thread_id is null and review.reviewer_turn_id is null)) for update;
  if not found or p_runtime_role <> 'independent_reviewer'
    or p_thread_id is null or p_turn_id is null then return false; end if;
  select work.codex_thread_id,
    work.cancellation_requested_at is not null or work.cancelled_at is not null
  into implementation_thread, implementation_canceled
  from momi_agent_ops.dispatches work
  where work.dispatch_id = attempt.implementation_dispatch_id for update;
  if implementation_thread is null or implementation_thread = p_thread_id then return false; end if;
  if implementation_canceled or attempt.state in ('canceled', 'superseded') then
    update momi_agent_ops.review_attempts review set runtime_role = p_runtime_role,
      reviewer_thread_id = p_thread_id, reviewer_turn_id = p_turn_id,
      started_at = coalesce(review.started_at, now()), updated_at = now()
    where review.review_attempt_id = attempt.review_attempt_id;
    return false;
  end if;
  update momi_agent_ops.review_attempts review set state = 'running',
    runtime_role = p_runtime_role, reviewer_thread_id = p_thread_id,
    reviewer_turn_id = p_turn_id, started_at = now(), updated_at = now()
  where review.review_attempt_id = attempt.review_attempt_id;
  update momi_agent_ops.run_records run set review_state = 'running', updated_at = now()
  where run.dispatch_id = attempt.implementation_dispatch_id;
  return true;
end;
$$;

create function momi_agent_ops.record_review_start_ambiguous_v1(
  p_reviewer_dispatch_id uuid,
  p_capability_token uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare implementation_id uuid;
begin
  update momi_agent_ops.review_attempts review set state = 'ambiguous',
    terminal_at = coalesce(review.terminal_at, now()), updated_at = now()
  where review.reviewer_dispatch_id = p_reviewer_dispatch_id
    and review.reviewer_capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and review.state = 'reserved'
  returning review.implementation_dispatch_id into implementation_id;
  if not found then return false; end if;
  update momi_agent_ops.run_records run set review_state = 'failed',
    review_receipt_id = null, review_check_sha = null, updated_at = now()
  where run.dispatch_id = implementation_id;
  return true;
end;
$$;

create function momi_agent_ops.record_review_result_v1(
  p_reviewer_dispatch_id uuid,
  p_capability_token uuid,
  p_runtime_role text,
  p_thread_id text,
  p_turn_id text,
  p_repository text,
  p_pull_request_number bigint,
  p_head_sha text,
  p_base_sha text,
  p_generation integer,
  p_profile text,
  p_review_model text,
  p_reasoning_effort text,
  p_budget_fingerprint text,
  p_policy_version text,
  p_result text,
  p_findings jsonb,
  p_result_fingerprint text,
  p_result_artifact_ref text,
  p_telemetry jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare attempt momi_agent_ops.review_attempts%rowtype;
declare blocking_count integer;
declare nonblocking_count integer;
declare canceled boolean;
declare implementation_thread text;
begin
  if p_runtime_role <> 'independent_reviewer'
    or (p_profile, p_review_model, p_reasoning_effort, p_budget_fingerprint) not in (
      ('low', 'gpt-5.6-luna', 'low', 'fnv1a64:9ede9fa30f041ad1'),
      ('standard', 'gpt-5.6-terra', 'medium', 'fnv1a64:9631b8b9d5daf636'),
      ('high', 'gpt-5.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a'))
    or p_result not in ('accepted', 'changes_requested', 'inconclusive', 'escalate')
    or jsonb_typeof(p_findings) <> 'array' or pg_column_size(p_findings) > 65536
    or p_result_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or length(p_result_artifact_ref) not between 1 and 500
    or jsonb_typeof(p_telemetry) <> 'object' or pg_column_size(p_telemetry) > 16384 then
    raise exception 'review_result_invalid' using errcode = '22023';
  end if;
  select review.* into attempt from momi_agent_ops.review_attempts review
  where review.reviewer_dispatch_id = p_reviewer_dispatch_id
    and review.reviewer_capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and ((review.runtime_role = p_runtime_role and review.reviewer_thread_id = p_thread_id
      and review.reviewer_turn_id = p_turn_id) or (review.state = 'ambiguous'
      and review.runtime_role is null and review.reviewer_thread_id is null
      and review.reviewer_turn_id is null))
    and review.repository = p_repository and review.pull_request_number = p_pull_request_number
    and review.head_sha = p_head_sha and review.base_sha = p_base_sha
    and review.generation = p_generation and review.profile = p_profile
    and review.review_model = p_review_model
    and review.reasoning_effort = p_reasoning_effort
    and review.budget_fingerprint = p_budget_fingerprint
    and review.policy_version = p_policy_version for update;
  if not found then return false; end if;
  if attempt.state = 'ambiguous' and attempt.reviewer_thread_id is null then
    select work.codex_thread_id into implementation_thread
    from momi_agent_ops.dispatches work
    where work.dispatch_id = attempt.implementation_dispatch_id;
    if implementation_thread is null or implementation_thread = p_thread_id then return false; end if;
    update momi_agent_ops.review_attempts review set runtime_role = p_runtime_role,
      reviewer_thread_id = p_thread_id, reviewer_turn_id = p_turn_id,
      started_at = coalesce(review.started_at, now()), updated_at = now()
    where review.review_attempt_id = attempt.review_attempt_id;
  end if;
  if attempt.state in ('ambiguous', 'stale', 'superseded', 'canceled') then
    update momi_agent_ops.review_attempts review set
      result = p_result, findings = p_findings,
      result_fingerprint = p_result_fingerprint, result_artifact_ref = p_result_artifact_ref,
      telemetry = p_telemetry, terminal_at = coalesce(review.terminal_at, now()),
      interruption_confirmed_at = coalesce(review.interruption_confirmed_at, now()),
      updated_at = now()
    where review.review_attempt_id = attempt.review_attempt_id;
    return true;
  elsif attempt.state <> 'running' then
    return attempt.result = p_result
      and attempt.result_fingerprint = p_result_fingerprint
      and attempt.result_artifact_ref = p_result_artifact_ref
      and attempt.findings = p_findings;
  end if;
  select count(*) filter (where item->>'severity' = 'blocking'),
    count(*) filter (where item->>'severity' = 'nonblocking')
  into blocking_count, nonblocking_count from jsonb_array_elements(p_findings) item;
  if exists (select 1 from jsonb_array_elements(p_findings) item
    where item->>'severity' not in ('blocking', 'nonblocking')
      or coalesce(item->>'id', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$'
      or coalesce(item->>'path', '') = ''
      or coalesce(item->>'required_outcome', '') = '')
    or (p_result = 'accepted' and blocking_count > 0) then
    raise exception 'review_findings_invalid' using errcode = '22023';
  end if;
  select work.cancellation_requested_at is not null or work.cancelled_at is not null
  into canceled from momi_agent_ops.dispatches work
  where work.dispatch_id = attempt.implementation_dispatch_id;
  update momi_agent_ops.review_attempts review set
    state = case when canceled then 'canceled' when p_result = 'escalate' then 'escalated'
      else p_result end,
    result = p_result, findings = p_findings, blocking_finding_count = blocking_count,
    nonblocking_finding_count = nonblocking_count,
    result_fingerprint = p_result_fingerprint, result_artifact_ref = p_result_artifact_ref,
    telemetry = p_telemetry, terminal_at = now(),
    canceled_at = case when canceled then now() else null end, updated_at = now()
  where review.review_attempt_id = attempt.review_attempt_id;
  update momi_agent_ops.run_records run set
    review_state = case when canceled then 'failed' when p_result = 'accepted' then 'succeeded'
      when p_result = 'changes_requested' then 'changes_requested'
      when p_result = 'inconclusive' then 'inconclusive' else 'pending' end,
    review_receipt_id = case when not canceled and p_result = 'accepted'
      then attempt.review_attempt_id else null end,
    merge_preflight_sha = null, merge_preflight_base_sha = null,
    merge_preflight_review_receipt_id = null, merge_preflight_at = null,
    updated_at = now()
  where run.dispatch_id = attempt.implementation_dispatch_id;
  return true;
end;
$$;

create function momi_agent_ops.record_review_check_v1(
  p_dispatch_id uuid,
  p_review_attempt_id uuid,
  p_head_sha text,
  p_check_name text,
  p_conclusion text
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_check_name <> 'Symphony Independent Review' or p_conclusion <> 'success' then return false; end if;
  update momi_agent_ops.run_records run set review_check_sha = p_head_sha, updated_at = now()
  where run.dispatch_id = p_dispatch_id and run.review_receipt_id = p_review_attempt_id
    and run.review_state = 'succeeded' and run.review_sha = p_head_sha
    and exists (select 1 from momi_agent_ops.review_attempts attempt
      where attempt.review_attempt_id = p_review_attempt_id
        and attempt.implementation_dispatch_id = p_dispatch_id
        and attempt.state = 'accepted' and attempt.head_sha = p_head_sha);
  return found;
end;
$$;

create function momi_agent_ops.merge_review_eligible_v1(
  p_dispatch_id uuid,
  p_repository text,
  p_base_branch text,
  p_pull_request_number bigint,
  p_head_sha text,
  p_base_sha text,
  p_policy_version text,
  p_profile text
) returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from momi_agent_ops.dispatches work
    join momi_agent_ops.run_records run on run.dispatch_id = work.dispatch_id
    join momi_agent_ops.review_attempts review on review.review_attempt_id = run.review_receipt_id
    where work.dispatch_id = p_dispatch_id and work.action = ('exec' || 'ute-run')
      and work.work_status in ('writeback_pending', 'active')
      and work.cancellation_requested_at is null and work.cancelled_at is null
      and work.mapped_repository = p_repository and work.mapped_base_branch = p_base_branch
      and run.pull_request_number = p_pull_request_number
      and run.head_sha = p_head_sha and run.validation_state = 'succeeded'
      and run.validation_sha = p_head_sha and run.review_state = 'succeeded'
      and run.review_sha = p_head_sha and run.review_base_sha = p_base_sha
      and run.review_policy_version = p_policy_version and run.review_profile = p_profile
      and review.state = 'accepted'
      and review.repository = p_repository and review.pull_request_number = p_pull_request_number
      and review.head_sha = p_head_sha and review.base_sha = p_base_sha
      and review.policy_version = p_policy_version and review.profile = p_profile
      and review.runtime_role = 'independent_reviewer'
      and review.reviewer_thread_id is distinct from work.codex_thread_id
  );
$$;

create function momi_agent_ops.record_merge_preflight_v1(
  p_dispatch_id uuid,
  p_capability_token uuid,
  p_thread_id text,
  p_turn_id text,
  p_repository text,
  p_base_branch text,
  p_pull_request_number bigint,
  p_head_sha text,
  p_base_sha text,
  p_policy_version text,
  p_profile text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare receipt_id uuid;
begin
  select run.review_receipt_id into receipt_id
  from momi_agent_ops.dispatches work
  join momi_agent_ops.run_records run on run.dispatch_id = work.dispatch_id
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
    and work.mapped_repository = p_repository and work.mapped_base_branch = p_base_branch
    and work.cancellation_requested_at is null and work.cancelled_at is null
  for update of run;
  if not found or receipt_id is null or not momi_agent_ops.merge_review_eligible_v1(
    p_dispatch_id, p_repository, p_base_branch, p_pull_request_number,
    p_head_sha, p_base_sha, p_policy_version, p_profile
  ) then return false; end if;
  update momi_agent_ops.run_records run set
    merge_preflight_sha = p_head_sha, merge_preflight_base_sha = p_base_sha,
    merge_preflight_review_receipt_id = receipt_id,
    merge_preflight_at = now(), updated_at = now()
  where run.dispatch_id = p_dispatch_id;
  return found;
end;
$$;

create function momi_agent_ops.get_review_status_v1(
  p_dispatch_id uuid,
  p_capability_token uuid,
  p_thread_id text,
  p_turn_id text
) returns table (
  state text, result text, findings jsonb, reviewer_dispatch_id uuid,
  head_sha text, base_sha text, generation integer, profile text,
  review_model text, reasoning_effort text, budget_fingerprint text, policy_version text
) language sql stable security invoker set search_path = '' as $$
  select review.state, review.result, review.findings, review.reviewer_dispatch_id,
    review.head_sha, review.base_sha, review.generation, review.profile,
    review.review_model, review.reasoning_effort, review.budget_fingerprint,
    review.policy_version
  from momi_agent_ops.dispatches work
  join momi_agent_ops.review_attempts review
    on review.implementation_dispatch_id = work.dispatch_id
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
  order by review.generation desc limit 1;
$$;

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

create function momi_agent_ops.record_lifecycle_evidence_v3(
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
  p_previous_revision_sha text,
  p_revision_sha text,
  p_merge_sha text,
  p_workflow_run_id text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
declare current_dispatch_id uuid;
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
    and work.cancellation_requested_at is null and work.cancelled_at is null
  for update;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'momi_agent_ops.dispatch_generation:' || selected.linear_issue_id::text, 0));
  select newest.dispatch_id into current_dispatch_id
  from momi_agent_ops.dispatches newest
  where newest.linear_issue_id = selected.linear_issue_id
    and newest.action not in ('cancel-run', 'recover-discovery')
  order by newest.created_at desc, newest.dispatch_id desc limit 1;
  if current_dispatch_id is distinct from selected.dispatch_id then return false; end if;
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
    update momi_agent_ops.review_attempts review set
      state = case when review.state in ('reserved', 'running') then 'superseded' else 'stale' end,
      stale_at = now(), terminal_at = coalesce(review.terminal_at, now()), updated_at = now()
    where review.implementation_dispatch_id = p_dispatch_id
      and review.state in ('reserved', 'running', 'accepted');
    update momi_agent_ops.run_records run set
      branch_name = p_branch_name, pull_request_number = p_pull_request_number,
      head_sha = p_revision_sha, validation_state = p_status,
      validation_sha = p_revision_sha, validation_workflow_run_id = p_workflow_run_id,
      review_state = 'not_required', review_sha = null, review_base_sha = null,
      review_policy_version = null, review_profile = null, review_receipt_id = null,
      review_check_sha = null, merge_preflight_sha = null,
      merge_preflight_base_sha = null, merge_preflight_review_receipt_id = null,
      merge_preflight_at = null, updated_at = now()
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

create function momi_agent_ops.fence_cancellation_v1(
  p_dispatch_id uuid, p_capability_token uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare selected_target uuid;
begin
  select work.target_dispatch_id into selected_target
  from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id and work.action = 'cancel-run'
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.work_status in ('claimed', 'writeback_pending')
    and work.cancellation_state = 'requested'
  for update;
  if not found or selected_target is null then return false; end if;
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

create function momi_agent_ops.record_cancellation_v3(
  p_dispatch_id uuid, p_capability_token uuid, p_cancellation_state text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare selected_target uuid;
declare recorded boolean;
begin
  select work.target_dispatch_id into selected_target
  from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id and work.action = 'cancel-run'
    and work.capability_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex');
  if not found or selected_target is null then return false; end if;
  recorded := momi_agent_ops.record_cancellation_v2(
    p_dispatch_id, p_capability_token, p_cancellation_state
  );
  if not recorded then return false; end if;
  with recursive lifecycle as (
    select selected_target as dispatch_id
    union all
    select child.dispatch_id from momi_agent_ops.dispatches child
    join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
    where child.action = ('exec' || 'ute-run')
  )
  update momi_agent_ops.review_attempts review set state = 'canceled',
    canceled_at = coalesce(review.canceled_at, now()),
    terminal_at = coalesce(review.terminal_at, now()),
    updated_at = now()
  where review.implementation_dispatch_id in (
    select owned.dispatch_id from lifecycle owned
  ) and review.state in ('reserved', 'running');
  with recursive lifecycle as (
    select selected_target as dispatch_id
    union all
    select child.dispatch_id from momi_agent_ops.dispatches child
    join lifecycle parent on child.parent_dispatch_id = parent.dispatch_id
    where child.action = ('exec' || 'ute-run')
  )
  update momi_agent_ops.run_records run set review_state = 'failed',
    review_receipt_id = null, review_check_sha = null,
    merge_preflight_sha = null, merge_preflight_base_sha = null,
    merge_preflight_review_receipt_id = null, merge_preflight_at = null,
    updated_at = now()
  where run.dispatch_id in (select owned.dispatch_id from lifecycle owned)
    and exists (select 1 from momi_agent_ops.review_attempts review
      where review.implementation_dispatch_id = run.dispatch_id
        and review.state = 'canceled');
  return true;
end;
$$;

create function momi_agent_ops.record_terminal_v5(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_readiness_result text, p_terminal_disposition text,
  p_terminal_summary text, p_archived_at timestamptz, p_telemetry jsonb
) returns table (
  issue_id uuid, issue_identifier text, action text, linear_comment_id uuid
) language plpgsql security invoker set search_path = '' as $$
declare selected momi_agent_ops.dispatches%rowtype;
declare run momi_agent_ops.run_records%rowtype;
begin
  select work.* into selected from momi_agent_ops.dispatches work
  where work.dispatch_id = p_dispatch_id
    and work.host_callback_token_hash = encode(extensions.digest(
      convert_to(p_capability_token::text, 'UTF8'), 'sha256'), 'hex')
    and work.codex_thread_id = p_thread_id and work.codex_turn_id = p_turn_id
  for update;
  if not found then return; end if;
  select record.* into run from momi_agent_ops.run_records record
  where record.dispatch_id = p_dispatch_id;
  if selected.action = ('exec' || 'ute-run') and p_readiness_result = 'ready'
    and p_terminal_disposition = 'completed' and run.pull_request_number is not null
    and (run.validation_state <> 'succeeded' or run.review_state <> 'succeeded'
      or run.review_receipt_id is null or run.review_check_sha is distinct from run.head_sha
      or run.merge_preflight_sha is distinct from run.head_sha
      or run.merge_preflight_base_sha is distinct from run.review_base_sha
      or run.merge_preflight_review_receipt_id is distinct from run.review_receipt_id
      or run.merge_sha is null or run.release_state <> 'succeeded') then
    raise exception 'implementation_terminal_obligations_incomplete' using errcode = '23514';
  end if;
  return query select result.issue_id, result.issue_identifier, result.action,
    result.linear_comment_id from momi_agent_ops.record_terminal_v4(
      p_dispatch_id, p_capability_token, p_thread_id, p_turn_id,
      p_readiness_result, p_terminal_disposition, p_terminal_summary,
      p_archived_at, p_telemetry
    ) result;
end;
$$;

revoke all on function momi_agent_ops.create_review_attempt_v1(
  uuid, uuid, text, text, text, text, bigint, text, text, text, text, text, text,
  text, text[], text[], uuid, integer
), momi_agent_ops.create_escalated_review_attempt_v1(
    uuid, uuid, text, text, text, text, text, text[], integer
  ), momi_agent_ops.record_reviewer_start_v1(uuid, uuid, text, text, text),
  momi_agent_ops.record_review_start_ambiguous_v1(uuid, uuid),
  momi_agent_ops.record_review_result_v1(
    uuid, uuid, text, text, text, text, bigint, text, text, integer, text, text,
    text, text, text, text, jsonb, text, text, jsonb
  ), momi_agent_ops.record_review_check_v1(uuid, uuid, text, text, text),
  momi_agent_ops.merge_review_eligible_v1(uuid, text, text, bigint, text, text, text, text),
  momi_agent_ops.record_merge_preflight_v1(
    uuid, uuid, text, text, text, text, bigint, text, text, text, text
  ),
  momi_agent_ops.get_review_status_v1(uuid, uuid, text, text),
  momi_agent_ops.serialize_dispatch_generation_v1(),
  momi_agent_ops.record_lifecycle_evidence_v3(
    uuid, uuid, text, text, text, text, text, bigint, text, text, text, text, text, text
  ),
  momi_agent_ops.fence_cancellation_v1(uuid, uuid),
  momi_agent_ops.record_cancellation_v3(uuid, uuid, text),
  momi_agent_ops.record_terminal_v5(
    uuid, uuid, text, text, text, text, text, timestamptz, jsonb
  )
  from public, anon, authenticated, service_role;
