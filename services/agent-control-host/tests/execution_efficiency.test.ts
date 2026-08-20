import assert from "node:assert/strict"
import test from "node:test"

import { buildCodexPrompt } from "../../agent-control/functions/momi-agent-control-dispatch-v1/src/build_codex_instruction.ts"
import type { ClaimedDispatch } from "../../agent-control/functions/momi-agent-control-dispatch-v1/src/types.ts"
import { buildActionContextEnvelope, budgetForAction, NO_MODEL_OPERATIONS } from "../../agent-control/src/execution_efficiency.ts"
import { budgetDisposition, buildAttemptTelemetry } from "../src/attempt_telemetry.ts"
import { compactToolReceipt, continuationDelta, MAX_DIAGNOSTIC_BYTES } from "../src/execution_receipts.ts"
import { parseHostDispatch } from "../src/parse_host_dispatch.ts"
import { startHostTask } from "../src/start_host_task.ts"
import type { AppServerClient, HostDispatch, HostRecord } from "../src/types.ts"

const work = { work_id: "00000000-0000-4000-8000-000000000001",
  issue_id: "00000000-0000-4000-8000-000000000002", issue_identifier: "MOX-234",
  action: "execute-run", issue_url: "https://linear.app/x/issue/MOX-234/x",
  project_id: "00000000-0000-4000-8000-000000000003",
  project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
  base_branch: "main", active_states: ["Todo", "In Progress", "Rework"],
  host_dispatch_url: "https://host.example/v1/dispatch", rejection_code: null,
  delivery_phase: "host", parent_dispatch_id: null, target_dispatch_id: null,
  cancellation_state: "not_requested", recovery_state: "not_requested",
  thread_id: null, turn_id: null, linear_comment_id: null } as ClaimedDispatch

test("action context includes exact bounded sources and excludes broad history", () => {
  const envelope = buildActionContextEnvelope({ ...work,
    project_id: work.project_id!, project_name: work.project_name!,
    repository: work.repository!, base_branch: work.base_branch!, active_states: work.active_states! })
  assert.deepEqual(envelope.sources.map((source) => source.reason), [
    "current bounded issue snapshot", "native parent, child, and blocker preflight",
    "canonical project mapping verification", "applicable repository authority and delivery rules",
    "owning control-plane service rules", "owning host transport rules",
  ])
  assert.equal(envelope.sources.every((source) => source.required &&
    source.fingerprint.startsWith("fnv1a64:")), true)
  assert.equal(JSON.stringify(envelope).includes("all comments"), false)
})

test("stable prompt prefix is cacheable while attempt evidence remains volatile", () => {
  const first = buildCodexPrompt(work)
  const second = buildCodexPrompt({ ...work,
    work_id: "00000000-0000-4000-8000-000000000009" })
  assert.equal(first.stablePrefix, second.stablePrefix)
  assert.equal(first.stablePrefixFingerprint, second.stablePrefixFingerprint)
  assert.notEqual(first.volatileContext, second.volatileContext)
  assert.notEqual(first.contextFingerprint, second.contextFingerprint)
  assert.ok(Buffer.byteLength(first.volatileContext) <
    Buffer.byteLength(`${first.stablePrefix}\n${first.volatileContext}`))
})

test("tool receipts are bounded, redacted, evidence-linked, and failure-specific", () => {
  const output = `Bearer abc.def token=super-secret\npath failure\n${"x".repeat(10_000)}`
  const receipt = compactToolReceipt({ status: "failed", command_id: "check:unit",
    duration_ms: 12.8, output, artifact_ref: "artifact://logs/1", error_code: "test_failed",
    repair_class: "code", path: "src/a.ts", line: 7 })
  assert.equal(receipt.status, "failed")
  assert.equal(receipt.artifact_ref, "artifact://logs/1")
  assert.match(receipt.output_hash, /^sha256:/)
  assert.equal(receipt.diagnostic_excerpt?.includes("super-secret"), false)
  assert.ok(Buffer.byteLength(receipt.diagnostic_excerpt ?? "") <= MAX_DIAGNOSTIC_BYTES)
  const success = compactToolReceipt({ status: "succeeded", command_id: "check:unit",
    duration_ms: 3, output: "ok", artifact_ref: "receipt://unit" })
  assert.equal(success.diagnostic_excerpt, undefined)
})

test("continuation uses checkpoint plus delta and stops the third identical failure", () => {
  const checkpoint = { schema_version: 1 as const,
    work_id: work.work_id, milestone: "focused_validation_complete" as const,
    issue_revision: "issue-r1", tree_hash: "tree-a", policy_version: "policy-v1",
    completed_receipts: ["receipt://focused"], failure_fingerprints: ["same", "same"] }
  assert.deepEqual(continuationDelta({ ...checkpoint, failure_fingerprints: ["old"] }, {
    issue_revision: "issue-r1", tree_hash: "tree-a", policy_version: "policy-v1",
    diagnostic_fingerprint: "new", evidence: { diagnostic: "changed" },
  }).new_evidence, { diagnostic: "changed" })
  assert.throws(() => continuationDelta(checkpoint, { issue_revision: "issue-r1",
    tree_hash: "tree-a", policy_version: "policy-v1",
    diagnostic_fingerprint: "same", evidence: {} }), /repeated_failure_budget_exhausted/)
  assert.throws(() => continuationDelta(checkpoint, { issue_revision: "issue-r2",
    tree_hash: "tree-a", policy_version: "policy-v1", evidence: {} }), /issue_changed/)
})

test("budgets fail closed and deterministic control-plane operations use zero model turns", () => {
  const record = { workId: work.work_id, fingerprint: "dispatch", capabilityToken: "token",
    state: "accepted", threadId: "thread", turnId: "turn", terminal: null,
    callbackSent: false, cancellationRequestedAt: null, updatedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(), budget: { ...budgetForAction("validate-issue"),
      model_visible_tool_bytes: 5 }, policyVersion: "policy",
    stablePrefixFingerprint: "stable", contextFingerprint: "context" } as HostRecord
  const telemetry = buildAttemptTelemetry(record, { id: "turn", status: "completed",
    items: [{ type: "toolResult", output: "more than five bytes" }],
    usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3,
      model_turns: 2 } }, "completed", 10)
  assert.equal(telemetry.cached_input_tokens, 10)
  assert.equal(budgetDisposition(record, telemetry), "budget_tool_output_exhausted")
  assert.equal(budgetForAction("cancel-run").model_turns, 0)
  assert.equal(budgetForAction("recover-discovery").model_turns, 0)
  assert.ok(NO_MODEL_OPERATIONS.length >= 8)
})

test("v3 host transport keeps stable and volatile inputs separate", async () => {
  const prompt = buildCodexPrompt(work)
  const dispatch = { schema_version: 3, work_id: work.work_id,
    capability_token: "00000000-0000-4000-8000-000000000004",
    issue_id: work.issue_id, issue_identifier: work.issue_identifier,
    issue_url: work.issue_url, project_id: work.project_id!, project_name: work.project_name!,
    repository: work.repository!, base_branch: work.base_branch!, active_states: work.active_states!,
    interaction_mode: "one_shot", thread_name: "MOX-234 · execute-run",
    stable_instruction: prompt.stablePrefix, volatile_context: prompt.volatileContext,
    stable_prefix_fingerprint: prompt.stablePrefixFingerprint,
    context_fingerprint: prompt.contextFingerprint, policy_version: "mox-execution-efficiency-v1",
    budget: budgetForAction("execute-run") } as HostDispatch
  assert.deepEqual(parseHostDispatch(dispatch), dispatch)
  assert.equal(parseHostDispatch({ ...dispatch,
    budget: { ...dispatch.budget!, model_turns: 65 } }), null)
  const requests: Array<{ method: string; params: unknown }> = []
  const client = { connect: async () => undefined, onNotification: () => undefined,
    request: async <T>(method: string, params: unknown): Promise<T> => {
      requests.push({ method, params })
      return (method === "thread/start" ? { thread: { id: "thread" } }
        : method === "turn/start" ? { turn: { id: "turn" } } : {}) as T
    } } as AppServerClient
  await startHostTask(client, { workspaceRoot: "/workspace", repository: work.repository!,
    baseBranch: "main" }, dispatch)
  const input = (requests.find((request) => request.method === "turn/start")?.params as {
    input: Array<{ text: string }> }).input
  assert.deepEqual(input.map((item) => item.text), [prompt.stablePrefix, prompt.volatileContext])
})
