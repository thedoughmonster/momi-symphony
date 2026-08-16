import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const foundationPath = "supabase/migrations/20260814125234_create_agent_control.sql"
const adapterPath = "supabase/migrations/20260814125236_add_agent_control_dispatch_trigger_adapter.sql"
const hostConfigPath = "supabase/migrations/20260814170037_configure_agent_control_host_endpoint.sql"
const actionCatalogPath = "supabase/migrations/20260814192000_add_agent_control_action_catalog.sql"
const parentRunsPath = "supabase/migrations/20260815061500_add_agent_control_parent_runs.sql"
const recoveryPath = "supabase/migrations/20260816083201_add_simple_discovery_recovery.sql"

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
