import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
const foundationPath = "supabase/migrations/20260814125234_create_agent_control.sql"
const adapterPath = "supabase/migrations/20260814125236_add_agent_control_dispatch_trigger_adapter.sql"
const hostConfigPath = "supabase/migrations/20260814170037_configure_agent_control_host_endpoint.sql"
const actionCatalogPath = "supabase/migrations/20260814192000_add_agent_control_action_catalog.sql"
const parentRunsPath = "supabase/migrations/20260815061500_add_agent_control_parent_runs.sql"
const recoveryPath = "supabase/migrations/20260816083201_add_simple_discovery_recovery.sql"
const deadLetterPath = "supabase/migrations/20260816183827_add_agent_control_dead_letter_recovery.sql"
const schedulerPath = "supabase/migrations/20260819045838_add_ready_leaf_scheduler.sql"
const decisionAlertPath = "supabase/migrations/20260819082707_add_decision_alert_lifecycle.sql"
const efficiencyPath = "supabase/migrations/20260820070000_add_execution_efficiency_telemetry.sql"
const lifecyclePath = "supabase/migrations/20260820130000_add_canonical_agent_state_lifecycle.sql"
const nativeCancellationPath =
  "supabase/migrations/20260820143000_retire_action_labels_and_native_cancellation.sql"
const independentReviewPath =
  "supabase/migrations/20260820160000_add_independent_pr_review_gate.sql"
test("private agent ledger is owned, defended, and absent from the Data API", async () => {
  const [foundation, config] = await Promise.all([
    readFile(foundationPath, "utf8"), readFile("supabase/config.toml", "utf8") ])
  assert.equal(foundation.split("\n")[0], "-- service-owner: agent-control")
  assert.match(foundation, /create schema momi_agent_ops/)
  assert.match(foundation, /enable row level security/g)
  assert.match(foundation, /revoke all on schema momi_agent_ops from public, anon, authenticated, service_role/)
  assert.doesNotMatch(config.match(/schemas = \[[^\n]+/)?.[0] ?? "", /momi_agent_ops/)
})
test("parent runs and cancellation keep reconstructable idempotent evidence", async () => {
  const migration = await readFile(parentRunsPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  assert.match(migration, /'cancel-run'/)
  assert.match(migration, /parent_dispatch_id uuid references momi_agent_ops\.dispatches/)
  assert.match(migration, /dispatches_parent_child_once_idx/)
  assert.match(migration, /target_dispatch_id uuid references momi_agent_ops\.dispatches/)
  for (const state of ["queued_cancelled", "requested", "already_terminal",
    "no_target", "operator_intervention"]) assert.match(migration, new RegExp(state))
  assert.match(migration, /create function momi_agent_ops\.accept_linear_webhook_v3/)
  assert.match(migration, /create function momi_agent_ops\.record_cancellation_v1/)
  assert.match(migration, /archive_state = 'not_applicable'/)
  assert.doesNotMatch(migration, /\bnet\.http_post\b/)
})
test("receipt, dispatch, claim, retry, and archive evidence are durable and idempotent", async () => {
  const foundation = await readFile(foundationPath, "utf8")
  assert.match(foundation, /delivery_id uuid primary key/)
  assert.match(foundation, /receipt_delivery_id uuid not null unique/)
  assert.match(foundation, /idempotency_key text not null unique/)
  assert.match(foundation, /capability_token_hash text not null/)
  assert.match(foundation, /host_callback_token_hash text check/)
  assert.match(foundation, /work\.capability_token_hash, work\.host_callback_token_hash/)
  assert.match(foundation, /for update skip locked/)
  assert.match(foundation, /work_status = 'claimed'/)
  assert.match(foundation, /work_status = case when work\.attempt_count >= 8 then 'dead_letter'/)
  assert.match(foundation, /wake_capability_token = case when work\.attempt_count >= 8 then null/)
  assert.match(foundation, /archive_state = 'archived'/)
  assert.doesNotMatch(foundation, /\bnet\.http_post\b/)
})

test("ADR-0004 trigger sends only work identity and transient capability token", async () => {
  const adapter = await readFile(adapterPath, "utf8")
  assert.equal(adapter.split("\n")[0], "-- service-owner: agent-control")
  assert.match(adapter, /body := jsonb_build_object\('work_id', new\.dispatch_id::text,\s+'capability_token', new\.wake_capability_token::text\)/)
  assert.match(adapter, /wake_capability_token = null/)
  assert.match(adapter, /after insert or update of wake_capability_token/)
  assert.match(adapter, /momi-agent-control-dispatch-recovery-v1/)
})

test("host endpoint stays private, HTTPS-only, and resolves at claim time", async () => {
  const hostConfig = await readFile(hostConfigPath, "utf8")
  assert.equal(hostConfig.split("\n")[0], "-- service-owner: agent-control")
  assert.match(hostConfig, /add column host_dispatch_url text/)
  assert.match(hostConfig, /host_dispatch_url ~ '\^https:\/\//)
  assert.match(hostConfig, /create function momi_agent_ops\.claim_dispatch_v2/)
  assert.match(hostConfig, /mapping\.host_dispatch_url/)
  assert.match(hostConfig, /left join momi_agent_ops\.project_mappings mapping/)
  assert.match(hostConfig, /grant execute on function momi_agent_ops\.claim_dispatch_v2/)
  assert.match(hostConfig, /revoke all on function momi_agent_ops\.claim_dispatch_v2/)
  assert.doesNotMatch(hostConfig, /\bnet\.http_post\b/)
})

test("action catalog preserves one idempotent dispatch and private write-back", async () => {
  const migration = await readFile(actionCatalogPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  for (const action of ["validate-issue", "investigate-issue",
    "cleanup", "decompose", "run-discovery"]) assert.match(migration, new RegExp(action))
  assert.match(migration, /'exec' \|\| 'ute-run'/)
  assert.match(migration, /p_action is null/)
  assert.match(migration, /disposition := 'duplicate'/)
  assert.match(migration, /'linear:' \|\| p_delivery_id::text \|\| ':' \|\| p_action/)
  assert.match(migration, /create function momi_agent_ops\.claim_dispatch_v3/)
  assert.match(migration, /create function momi_agent_ops\.record_terminal_v2/)
  assert.match(migration, /action_label_removed_at/)
  assert.doesNotMatch(migration, /\bnet\.http_post\b/)
})

test("discovery recovery is exact, state-independent, and releases only after archive", async () => {
  const migration = await readFile(recoveryPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  assert.match(migration, /'recover-discovery'/)
  assert.match(migration, /create function momi_agent_ops\.accept_linear_webhook_v4/)
  assert.match(migration, /target\.action = 'run-discovery'/)
  assert.match(migration, /run\.archive_state = 'pending'/)
  assert.match(migration, /target_count > 1/)
  assert.match(migration, /create function momi_agent_ops\.claim_dispatch_v5/)
  assert.match(migration, /then 'recover_host'/)
  assert.match(migration, /create function momi_agent_ops\.record_recovery_v1/)
  assert.match(migration, /'mapping_mismatch'/)
  assert.doesNotMatch(migration, /p_issue_state|workflow_state/)
  assert.doesNotMatch(migration, /\bnet\.http_post\b/)
})

test("dead-letter recovery is private, exact, and rotates the existing dispatch", async () => {
  const migration = await readFile(deadLetterPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  assert.match(migration, /create function momi_agent_ops\.recover_dead_letter_dispatch_v1/)
  assert.match(migration, /for update/)
  assert.match(migration, /'already_recovered'/)
  assert.match(migration, /selected\.work_status <> 'dead_letter'/)
  assert.match(migration, /selected\.attempt_count <> p_expected_attempt_count/)
  assert.match(migration, /selected\.host_accepted_at is not null/)
  assert.match(migration, /selected_run\.terminal_at is not null/)
  assert.match(migration, /selected_mapping\.host_dispatch_url is distinct from/)
  assert.match(migration, /fresh_capability := gen_random_uuid\(\)/)
  assert.match(migration, /work_status = 'pending', attempt_count = 0/)
  assert.match(migration, /wake_capability_token = fresh_capability/)
  assert.match(migration, /from public, anon, authenticated, service_role/)
  assert.doesNotMatch(migration, /insert into momi_agent_ops\./)
  assert.doesNotMatch(migration, /\bnet\.http_post\b/)
})

test("ready-leaf scheduling stays private, exact-release gated, and default disabled", async () => {
  const migration = await readFile(schedulerPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  for (const table of ["scheduler_route_policies", "scheduler_leaders",
    "scheduler_candidates", "scheduler_slots"]) {
    assert.match(migration, new RegExp(
      `alter table momi_agent_ops\\.${table} enable row level security`,
    ))
  }
  assert.match(migration, /mode text not null default 'disabled'/)
  assert.match(migration, /mode = 'enabled'[\s\S]+accepted_release_sha is not null[\s\S]+acceptance_completed_at is not null/)
  assert.equal(migration.match(/accepted_release_sha is distinct from p_release_sha/g)?.length, 2)
  assert.match(migration, /mode = 'observe' and cardinality\(acceptance_issue_ids\) between 1 and 20/)
  assert.match(migration, /revoke all on table momi_agent_ops\.scheduler_route_policies,[\s\S]+from public, anon, authenticated, service_role/)
  assert.match(migration, /revoke all on function momi_agent_ops\.acquire_scheduler_leader_v1[\s\S]+momi_agent_ops\.claim_scheduler_candidate_v1[\s\S]+from public, anon, authenticated, service_role/)
  assert.equal(migration.match(/security invoker set search_path = ''/g)?.length, 8)
  assert.doesNotMatch(migration, /security definer/i)
  assert.doesNotMatch(migration, /\bexecute\b(?!\s+function\b)/i)
  assert.doesNotMatch(migration, /\bnet\.http_post\b/)
})

test("decision alerts are private, attempt-first, exact-release gated, and separate from order alerts", async () => {
  const migration = await readFile(decisionAlertPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  for (const table of ["decision_alert_policies", "decision_alerts",
    "decision_delivery_work", "decision_delivery_attempts"]) {
    assert.match(migration, new RegExp(
      `alter table momi_agent_ops\\.${table} enable row level security`,
    ))
  }
  assert.match(migration, /mode text not null default 'disabled'/)
  assert.match(migration, /mode = 'acceptance'[\s\S]+accepted_release_sha is not null/)
  assert.match(migration, /insert into momi_agent_ops\.decision_delivery_attempts[\s\S]+outcome[\s\S]+'started'/)
  assert.match(migration, /work\.work_status = 'claimed' and work\.lease_expires_at <= now\(\)[\s\S]+then[\s\S]+ambiguous/)
  assert.match(migration, /decision_identity text not null unique/)
  assert.equal(migration.match(/security invoker set search_path = ''/g)?.length, 6)
  assert.doesNotMatch(migration, /security definer/i)
  assert.doesNotMatch(migration, /\bmomi_alerting\b|slack_order|order_alert/i)
  assert.doesNotMatch(migration, /\b(?:net|vault)\./i)
  assert.match(migration, /from public, anon, authenticated, service_role/)
})

test("execution telemetry is private, complete, percentile-backed, and atomic", async () => {
  const migration = await readFile(efficiencyPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  for (const table of ["execution_attempt_telemetry", "execution_checkpoints"]) {
    assert.match(migration, new RegExp(
      `alter table momi_agent_ops\\.${table} enable row level security`,
    ))
  }
  for (const field of ["input_tokens", "cached_input_tokens", "output_tokens",
    "model_visible_tool_bytes", "model_turns", "no_progress_cycles", "subagents",
    "max_subagent_depth", "retries", "repeated_failure_fingerprints", "elapsed_ms",
    "terminal_disposition"]) assert.match(migration, new RegExp(field))
  assert.match(migration, /create view momi_agent_ops\.execution_action_percentiles_v1/)
  assert.match(migration, /percentile_cont\(0\.5\)/)
  assert.match(migration, /percentile_cont\(0\.95\)/)
  assert.match(migration, /create function momi_agent_ops\.record_terminal_v3/)
  assert.match(migration, /momi_agent_ops\.record_terminal_v2/)
  assert.doesNotMatch(migration, /security definer/i)
  assert.doesNotMatch(migration, /\b(?:net|vault)\./i)
})

test("canonical Agent State evidence is exact-generation, private, and repairable", async () => {
  const migration = await readFile(lifecyclePath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  for (const state of ["queued", "checking", "working", "validating", "reviewing",
    "releasing", "waiting", "failed", "stopped", "complete", "coordinating"]) {
    assert.match(migration, new RegExp(`'${state}'`))
  }
  assert.match(migration, /lifecycle_version text not null default 'agent-state-v1'/)
  assert.match(migration, /run_records_exact_validation/)
  assert.match(migration, /validation_sha = head_sha/)
  assert.match(migration, /review_sha = head_sha/)
  assert.match(migration, /release_sha = merge_sha/)
  assert.match(migration, /current_dispatch_id is distinct from selected\.dispatch_id/)
  assert.match(migration, /record_agent_state_projection_v1/)
  assert.match(migration, /security invoker set search_path = ''/)
  assert.doesNotMatch(migration, /security definer/i)
  assert.doesNotMatch(migration, /\b(?:net|vault)\./i)
})

test("native cancellation retires routine labels and fences the exact lifecycle", async () => {
  const migration = await readFile(nativeCancellationPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  assert.match(migration, /linear_state_cancellation/)
  assert.match(migration, /afterType.*canceled/s)
  assert.match(migration, /with recursive lifecycle/)
  assert.match(migration, /parent_dispatch_id = parent\.dispatch_id/)
  assert.match(migration, /work_status = 'cancelled'/)
  assert.match(migration, /cancellation_requested_at is not null/)
  assert.match(migration, /record_lifecycle_evidence_v2/)
  assert.match(migration, /record_terminal_v4/)
  assert.match(migration, /validation_profile/)
  assert.match(migration, /request escalated validation/)
  assert.doesNotMatch(migration, /security definer/i)
  assert.doesNotMatch(migration, /\b(?:net|vault|cron)\./i)
})

test("independent review receipts are private, exact-revision, and author-proof", async () => {
  const migration = await readFile(independentReviewPath, "utf8")
  assert.equal(migration.split("\n")[0], "-- service-owner: agent-control")
  assert.match(migration, /create table momi_agent_ops\.review_attempts/)
  assert.match(migration, /implementation_dispatch_id uuid not null references/)
  assert.match(migration, /reviewer_dispatch_id uuid not null unique/)
  assert.match(migration, /reverification_of uuid references/)
  assert.match(migration, /escalation_of uuid references/)
  assert.match(migration, /escalation_depth integer not null default 0/)
  assert.match(migration, /source\.state = 'changes_requested'/)
  assert.match(migration, /runtime_role.*independent_reviewer/s)
  assert.match(migration, /head_sha text not null/)
  assert.match(migration, /base_sha text not null/)
  assert.match(migration, /profile in \('low', 'standard', 'high'\)/)
  assert.match(migration,
    /\('low', 'gpt-5\.6-luna', 'low', 'fnv1a64:9ede9fa30f041ad1'\)/)
  assert.match(migration,
    /\('standard', 'gpt-5\.6-terra', 'medium', 'fnv1a64:9631b8b9d5daf636'\)/)
  assert.match(migration,
    /\('high', 'gpt-5\.6-sol', 'high', 'fnv1a64:0b9ef0157af3f30a'\)/)
  assert.match(migration, /review\.review_model = p_review_model/)
  assert.match(migration, /review\.reasoning_effort = p_reasoning_effort/)
  assert.match(migration, /review\.budget_fingerprint = p_budget_fingerprint/)
  assert.match(migration, /create_review_attempt_v1/)
  assert.match(migration, /create_escalated_review_attempt_v1/)
  assert.match(migration, /when 'low' then 'standard'.*when 'standard' then 'high'/s)
  assert.match(migration, /disposition := 'review_budget_exhausted'/)
  assert.match(migration, /subject_attempt_number between 1 and 3/)
  assert.match(migration, /subject_attempt_limit = 3/)
  assert.match(migration, /review_attempts_one_escalation_idx/)
  assert.match(migration, /record_reviewer_start_v1/)
  assert.match(migration, /reviewer_thread_id is distinct from work\.codex_thread_id/)
  assert.match(migration, /create function momi_agent_ops\.fence_cancellation_v1/)
  assert.match(migration, /implementation_canceled/)
  assert.match(migration, /attempt\.state in \('canceled', 'superseded'\)/)
  assert.match(migration, /record_review_start_ambiguous_v1/)
  assert.match(migration, /record_review_cancellation_receipt_v1/)
  assert.match(migration, /cancellation_receipt_fingerprint/)
  assert.match(migration, /state in \('reserved', 'running', 'ambiguous'\)/)
  assert.match(migration, /disposition := 'already_ambiguous'/)
  assert.match(migration, /review\.state = 'ambiguous'.*review\.runtime_role is null/s)
  assert.match(migration, /attempt\.state = 'ambiguous'[\s\S]+state = 'failed'/)
  assert.match(migration, /interruption_confirmed_at = coalesce\(review\.interruption_confirmed_at, now\(\)\)/)
  assert.doesNotMatch(migration, /record_review_interruption_v1/)
  assert.doesNotMatch(migration, /interruption_confirmed_at = case when review\.state = 'running'/)
  assert.match(migration, /record_review_result_v1/)
  assert.match(migration, /p_result = 'accepted' and blocking_count > 0/)
  assert.match(migration, /begin_review_check_publication_v1/)
  assert.match(migration, /finish_review_check_publication_v1/)
  assert.match(migration, /prepare_review_check_revocations_v1/)
  assert.match(migration, /recover_abandoned_review_check_publication_v1/)
  assert.match(migration, /publication_started_at > now\(\) - interval '5 minutes'/)
  assert.match(migration, /record_review_check_revocation_v1/)
  assert.match(migration, /merge_review_eligible_v1/)
  assert.match(migration, /record_merge_preflight_v1/)
  assert.match(migration, /merge_preflight_review_receipt_id/)
  assert.match(migration, /run\.merge_sha is null/)
  assert.match(migration, /record_lifecycle_evidence_v3/)
  assert.match(migration, /if p_phase = 'reviewing' then return false/)
  assert.match(migration,
    /record_lifecycle_evidence_v3[\s\S]+fence_current_dispatch_generation_v1\(p_dispatch_id\)[\s\S]+for update/)
  assert.match(migration,
    /record_terminal_v5[\s\S]+fence_current_dispatch_generation_v1\(p_dispatch_id\)[\s\S]+for update/)
  assert.match(migration, /work\.action = \('exec' \|\| 'ute-run'\)/)
  assert.match(migration, /serialize_dispatch_generation_v1/)
  assert.match(migration, /fence_current_dispatch_generation_v1/)
  assert.match(migration, /disposition := 'current_generation_refused'/)
  assert.match(migration, /pg_advisory_xact_lock\(pg_catalog\.hashtextextended/)
  for (const routine of ["create_review_attempt_v1", "create_escalated_review_attempt_v1",
    "record_reviewer_start_v1", "record_review_result_v1",
    "record_lifecycle_evidence_v3", "record_terminal_v5"]) {
    const start = migration.indexOf(`create function momi_agent_ops.${routine}(`)
    const end = migration.indexOf("\n$$;", start)
    const body = migration.slice(start, end)
    assert.ok(start >= 0 && end > start, `${routine} body missing`)
    assert.ok(body.indexOf("fence_current_dispatch_generation_v1") >= 0,
      `${routine} generation fence missing`)
    assert.ok(body.indexOf("fence_current_dispatch_generation_v1") < body.indexOf("for update"),
      `${routine} must acquire the advisory fence before row locks`)
  }
  for (const routine of ["record_review_start_ambiguous_v1",
    "begin_review_check_publication_v1", "finish_review_check_publication_v1",
    "merge_review_eligible_v1", "record_merge_preflight_v1"]) {
    const start = migration.indexOf(`create function momi_agent_ops.${routine}(`)
    const end = migration.indexOf("\n$$;", start)
    const body = migration.slice(start, end)
    assert.ok(start >= 0 && end > start, `${routine} body missing`)
    assert.ok(body.indexOf("fence_current_dispatch_generation_v1") >= 0,
      `${routine} generation fence missing`)
  }
  for (const routine of ["record_review_cancellation_receipt_v1",
    "recover_abandoned_review_check_publication_v1"]) {
    const start = migration.indexOf(`create function momi_agent_ops.${routine}(`)
    const body = migration.slice(start, migration.indexOf("\n$$;", start))
    assert.ok(body.indexOf("pg_advisory_xact_lock") >= 0)
    assert.ok(body.indexOf("pg_advisory_xact_lock") < body.indexOf("for update"))
  }
  assert.match(migration,
    /current_run\.head_sha is distinct from p_previous_revision_sha then return false/)
  assert.match(migration, /current_run\.branch_name is distinct from p_branch_name/)
  assert.match(migration, /current_run\.pull_request_number is distinct from p_pull_request_number/)
  assert.match(migration, /record_terminal_v5/)
  assert.match(migration, /implementation_terminal_obligations_incomplete/)
  assert.match(migration, /review_attempts_one_active_idx/)
  assert.doesNotMatch(migration, /security definer/i)
  assert.doesNotMatch(migration, /\b(?:net|vault|cron)\./i)
  assert.match(migration, /from public, anon, authenticated, service_role/)
})
