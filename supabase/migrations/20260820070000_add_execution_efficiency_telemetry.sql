-- service-owner: agent-control

create table momi_agent_ops.execution_attempt_telemetry (
  dispatch_id uuid primary key references momi_agent_ops.dispatches(dispatch_id) on delete cascade,
  policy_version text not null check (length(policy_version) between 1 and 120),
  stable_prefix_fingerprint text not null check (length(stable_prefix_fingerprint) between 1 and 120),
  context_fingerprint text not null check (length(context_fingerprint) between 1 and 120),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  cached_input_tokens bigint check (cached_input_tokens is null or cached_input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  model_visible_tool_bytes bigint not null check (model_visible_tool_bytes >= 0),
  model_turns integer not null check (model_turns >= 0),
  no_progress_cycles integer not null check (no_progress_cycles >= 0),
  subagents integer not null check (subagents >= 0),
  max_subagent_depth integer not null check (max_subagent_depth >= 0),
  retries integer not null check (retries >= 0),
  repeated_failure_fingerprints integer not null check (repeated_failure_fingerprints >= 0),
  elapsed_ms bigint not null check (elapsed_ms >= 0),
  terminal_disposition text not null check (
    terminal_disposition in ('completed', 'failed', 'interrupted')),
  recorded_at timestamptz not null default now()
);

create table momi_agent_ops.execution_checkpoints (
  dispatch_id uuid not null references momi_agent_ops.dispatches(dispatch_id) on delete cascade,
  milestone text not null check (milestone in (
    'investigation_complete', 'plan_accepted', 'code_committed',
    'focused_validation_complete', 'ci_evidence_received')),
  issue_revision text not null check (length(issue_revision) between 1 and 160),
  tree_hash text not null check (length(tree_hash) between 1 and 160),
  policy_version text not null check (length(policy_version) between 1 and 120),
  completed_receipts text[] not null default '{}',
  failure_fingerprints text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (dispatch_id, milestone)
);

alter table momi_agent_ops.execution_attempt_telemetry enable row level security;
alter table momi_agent_ops.execution_checkpoints enable row level security;

create view momi_agent_ops.execution_action_percentiles_v1 as
select work.action, telemetry.policy_version, count(*) as attempts,
  percentile_cont(0.5) within group (order by telemetry.input_tokens)
    filter (where telemetry.input_tokens is not null) as input_tokens_p50,
  percentile_cont(0.95) within group (order by telemetry.input_tokens)
    filter (where telemetry.input_tokens is not null) as input_tokens_p95,
  percentile_cont(0.5) within group (order by telemetry.cached_input_tokens)
    filter (where telemetry.cached_input_tokens is not null) as cached_input_tokens_p50,
  percentile_cont(0.95) within group (order by telemetry.cached_input_tokens)
    filter (where telemetry.cached_input_tokens is not null) as cached_input_tokens_p95,
  percentile_cont(0.5) within group (order by telemetry.output_tokens)
    filter (where telemetry.output_tokens is not null) as output_tokens_p50,
  percentile_cont(0.95) within group (order by telemetry.output_tokens)
    filter (where telemetry.output_tokens is not null) as output_tokens_p95,
  percentile_cont(0.5) within group (order by telemetry.elapsed_ms) as elapsed_ms_p50,
  percentile_cont(0.95) within group (order by telemetry.elapsed_ms) as elapsed_ms_p95,
  percentile_cont(0.5) within group (order by telemetry.model_visible_tool_bytes) as tool_bytes_p50,
  percentile_cont(0.95) within group (order by telemetry.model_visible_tool_bytes) as tool_bytes_p95,
  percentile_cont(0.5) within group (order by telemetry.model_turns) as model_turns_p50,
  percentile_cont(0.95) within group (order by telemetry.model_turns) as model_turns_p95,
  percentile_cont(0.5) within group (order by telemetry.no_progress_cycles) as no_progress_p50,
  percentile_cont(0.95) within group (order by telemetry.no_progress_cycles) as no_progress_p95,
  percentile_cont(0.5) within group (order by telemetry.subagents) as subagents_p50,
  percentile_cont(0.95) within group (order by telemetry.subagents) as subagents_p95,
  percentile_cont(0.5) within group (order by telemetry.retries) as retries_p50,
  percentile_cont(0.95) within group (order by telemetry.retries) as retries_p95
from momi_agent_ops.execution_attempt_telemetry telemetry
join momi_agent_ops.dispatches work on work.dispatch_id = telemetry.dispatch_id
group by work.action, telemetry.policy_version;

create function momi_agent_ops.record_terminal_v3(
  p_dispatch_id uuid, p_capability_token uuid, p_thread_id text, p_turn_id text,
  p_readiness_result text, p_terminal_disposition text,
  p_terminal_summary text, p_archived_at timestamptz, p_telemetry jsonb
) returns table (
  issue_id uuid, issue_identifier text, action text, linear_comment_id uuid
) language plpgsql security invoker set search_path = '' as $$
declare selected record;
begin
  if p_telemetry is null or jsonb_typeof(p_telemetry) <> 'object' then
    raise exception 'invalid execution telemetry' using errcode = '22023';
  end if;
  select terminal.* into selected from momi_agent_ops.record_terminal_v2(
    p_dispatch_id, p_capability_token, p_thread_id, p_turn_id,
    p_readiness_result, p_terminal_disposition, p_terminal_summary, p_archived_at
  ) terminal;
  if not found then return; end if;
  insert into momi_agent_ops.execution_attempt_telemetry (
    dispatch_id, policy_version, stable_prefix_fingerprint, context_fingerprint,
    input_tokens, cached_input_tokens, output_tokens, model_visible_tool_bytes,
    model_turns, no_progress_cycles, subagents, max_subagent_depth, retries,
    repeated_failure_fingerprints, elapsed_ms,
    terminal_disposition
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
    (p_telemetry->>'elapsed_ms')::bigint, p_terminal_disposition
  ) on conflict (dispatch_id) do nothing;
  return query select selected.issue_id, selected.issue_identifier,
    selected.action, selected.linear_comment_id;
end;
$$;

grant all on function momi_agent_ops.record_terminal_v3(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb
) to service_role;
grant insert on momi_agent_ops.execution_attempt_telemetry to service_role;

revoke all on momi_agent_ops.execution_attempt_telemetry,
  momi_agent_ops.execution_checkpoints,
  momi_agent_ops.execution_action_percentiles_v1 from public, anon, authenticated;
revoke all on function momi_agent_ops.record_terminal_v3(
  uuid, uuid, text, text, text, text, text, timestamptz, jsonb
) from public, anon, authenticated;
