import assert from "node:assert/strict"
import test from "node:test"
import type { Sql } from "postgres"

import { REVIEW_CHECK_NAME, REVIEW_POLICY_VERSION } from "../../../src/independent_review.ts"
import { processMergeRequest, processReviewStatus, processReviewTerminal,
  promoteReviewProfile } from "../src/review_controller.ts"
import type { GitHubReviewGateway } from "../src/github_review_gateway.ts"
import type { MergeRequestInput, ReviewTerminalInput } from "../src/types.ts"

const implementationId = "00000000-0000-4000-8000-000000000001"
const reviewerId = "00000000-0000-4000-8000-000000000002"
const capability = "00000000-0000-4000-8000-000000000003"
const attemptId = "00000000-0000-4000-8000-000000000004"
const head = "a".repeat(40)
const base = "b".repeat(40)
const merge = "c".repeat(40)
const repository = "thedoughmonster/momi-symphony"

function sqlFake(handler: (query: string) => unknown): Sql {
  const sql = ((strings: TemplateStringsArray) => Promise.resolve(handler(strings.join("?")))) as
    unknown as Sql
  ;(sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value
  return sql
}

test("independent review never automatically escalates through profiles", () => {
  assert.equal(promoteReviewProfile("low"), null)
  assert.equal(promoteReviewProfile("standard"), null)
  assert.equal(promoteReviewProfile("high"), null)
})

test("review status returns one compact current attempt", async () => {
  const sql = sqlFake((query) => query.includes("get_review_status_v1") ? [{
    review_attempt_id: attemptId, parent_attempt_id: null, state: "pending", findings: [],
    failure_reason: null, reviewer_dispatch_id: reviewerId, reviewer_thread_id: "review-thread",
    head_sha: head, base_sha: base, profile: "high", policy_version: REVIEW_POLICY_VERSION }] : [])
  assert.deepEqual(await processReviewStatus({ event: "review_status", work_id: implementationId,
    capability_token: capability, thread_id: "implementation-thread",
    turn_id: "implementation-turn" }, sql), { ok: true, review_attempt_id: attemptId,
    parent_attempt_id: null, state: "pending", findings: [], failure_reason: null,
    reviewer_dispatch_id: reviewerId, reviewer_thread_id: "review-thread",
    head_sha: head, base_sha: base, profile: "high", policy_version: REVIEW_POLICY_VERSION })
})

test("terminal accepted result atomically records authority then projects success", async () => {
  const projected: string[] = []
  const sql = sqlFake((query) => {
    if (query.includes("mapped_repository")) return [{ repository }]
    if (query.includes("record_review_result_v1")) return [{ recorded: true }]
    if (query.includes("lock_current_review_subject_v1")) return [{ locked: true }]
    if (query.includes("current_review_authority_v1")) return [{ authorized: true }]
    return []
  })
  const github = { projectReviewCheck: (_repo: string, _head: string, state: string) => {
    projected.push(state); return Promise.resolve({}) } } as unknown as GitHubReviewGateway
  const input: ReviewTerminalInput = { event: "review_terminal", reviewer_dispatch_id: reviewerId,
    capability_token: capability, runtime_role: "independent_reviewer", thread_id: "review-thread",
    turn_id: "review-turn", review_subject: { implementation_dispatch_id: implementationId,
      pull_request_number: 16, head_sha: head, base_sha: base, profile: "high",
      policy_version: REVIEW_POLICY_VERSION }, review_result: { result: "accepted", findings: [] },
    terminal_disposition: "completed", archived_at: new Date().toISOString(),
    telemetry: { policy_version: "v1", stable_prefix_fingerprint: "fnv1a64:1111111111111111",
      context_fingerprint: "fnv1a64:2222222222222222", input_tokens: 1,
      cached_input_tokens: 0, output_tokens: 1, model_visible_tool_bytes: 1, model_turns: 1,
      no_progress_cycles: 0, subagents: 0, max_subagent_depth: 0, retries: 0,
      repeated_failure_fingerprints: 0, elapsed_ms: 1, disposition: "completed" } }
  assert.deepEqual(await processReviewTerminal(input, sql, github, () => Promise.resolve()),
    { ok: true, disposition: "accepted" })
  assert.deepEqual(projected, ["success"])
})

test("merge executes once under the shared lock and exact current authority", async () => {
  const sql = sqlFake((query) => {
    if (query.includes("host_dispatch_url")) return [{ host_dispatch_url:
      "https://host.example/v1/dispatch", issue_id: implementationId,
      issue_identifier: "MOX-434", issue_url: "https://linear.app/mox/issue/MOX-434/test",
      project_id: "project", project_name: "Symphony Control Plane", base_branch: "main",
      active_states: ["In Progress"] }]
    if (query.includes("lock_current_review_subject_v1")) return [{ locked: true }]
    if (query.includes("host_callback_token_hash")) return [{ work_status: "active",
      cancellation_requested_at: null, cancelled_at: null,
      validation_state: "succeeded", validation_sha: head }]
    if (query.includes("current_review_authority_v1")) return [{ review_attempt_id: attemptId,
      implementation_dispatch_id: implementationId, reviewer_dispatch_id: reviewerId,
      repository, pull_request_number: 16, head_sha: head, base_sha: base,
      policy_version: REVIEW_POLICY_VERSION, profile: "high",
      reviewer_identity: "independent_reviewer", reviewer_thread_id: "review-thread",
      reviewer_turn_id: "review-turn", state: "accepted", findings: [] }]
    return []
  })
  const github = { loadSubject: () => Promise.resolve({ repository, pullRequestNumber: 16,
    state: "open", baseBranch: "main", headSha: head, baseSha: base,
    changedPaths: ["supabase/migrations/x.sql"], riskDimensions: ["schema_migration"],
    changedFiles: [{ path: "supabase/migrations/x.sql",
      patch: "+alter table accounts drop column legacy" }],
    diffArtifactRef: "github://diff" }), loadMergeFacts: () => Promise.resolve({
      baseHeadSha: base, requiredCi: { headSha: head, conclusion: "success" },
      reviewCheck: { name: REVIEW_CHECK_NAME, headSha: head, conclusion: "success" },
      reviewCheckRequired: true, bypassPossible: false, authoritativeBlockingThreads: 0,
      authoritativeChangesRequested: false, authoritativeApprovals: 0 }), mergePullRequest: () =>
        Promise.resolve({ merged: true, sha: merge }) } as unknown as GitHubReviewGateway
  const input: MergeRequestInput = { event: "merge_request", work_id: implementationId,
    capability_token: capability, thread_id: "implementation-thread",
    turn_id: "implementation-turn", repository, base_branch: "main", pull_request_number: 16 }
  const loadIssue = () => Promise.resolve({ identifier: "MOX-434", state: "In Progress",
    native_ref: { project_id: "project" }, labels: [], description: "low risk" } as never)
  assert.deepEqual(await processMergeRequest(input, sql, github, loadIssue), {
    ok: true, eligible: true, merged: true, review_required: true, review_escalated: true,
    risk_triggers: ["destructive_migration"], head_sha: head, base_sha: base,
    merge_sha: merge })
})

test("normal-risk merge requires exact validation and an affirmative GitHub review", async () => {
  let validationState = "pending"
  let approvals = 1
  let mergeCalls = 0
  const sql = sqlFake((query) => {
    if (query.includes("host_dispatch_url")) return [{ host_dispatch_url:
      "https://host.example/v1/dispatch", issue_id: implementationId,
      issue_identifier: "MOX-434", issue_url: "https://linear.app/mox/issue/MOX-434/test",
      project_id: "project", project_name: "Symphony Control Plane", base_branch: "main",
      active_states: ["In Progress"] }]
    if (query.includes("lock_current_review_subject_v1")) return [{ locked: true }]
    if (query.includes("host_callback_token_hash")) return [{ work_status: "active",
      cancellation_requested_at: null, cancelled_at: null,
      validation_state: validationState, validation_sha: head }]
    return []
  })
  const github = { loadSubject: () => Promise.resolve({ repository, pullRequestNumber: 16,
    state: "open", baseBranch: "main", headSha: head, baseSha: base,
    changedPaths: ["src/copy.ts"], riskDimensions: ["general"],
    changedFiles: [{ path: "src/copy.ts", patch: "+export const copy = 'hello'" }],
    diffArtifactRef: "github://diff" }), loadMergeFacts: () => Promise.resolve({
      baseHeadSha: base, requiredCi: { headSha: head, conclusion: "success" },
      reviewCheck: { name: REVIEW_CHECK_NAME, headSha: head, conclusion: "success" },
      reviewCheckRequired: true, bypassPossible: false, authoritativeBlockingThreads: 0,
      authoritativeChangesRequested: false, authoritativeApprovals: approvals }),
    mergePullRequest: () => { mergeCalls += 1
      return Promise.resolve({ merged: true, sha: merge }) } } as unknown as GitHubReviewGateway
  const input: MergeRequestInput = { event: "merge_request", work_id: implementationId,
    capability_token: capability, thread_id: "implementation-thread",
    turn_id: "implementation-turn", repository, base_branch: "main", pull_request_number: 16 }
  const loadIssue = () => Promise.resolve({ identifier: "MOX-434", state: "In Progress",
    native_ref: { project_id: "project" }, labels: [], description: "normal risk" } as never)
  assert.deepEqual(await processMergeRequest(input, sql, github, loadIssue), {
    ok: true, eligible: false, merged: false, reason: "focused_validation_required",
    head_sha: head, base_sha: base })
  assert.equal(mergeCalls, 0)
  validationState = "succeeded"
  approvals = 0
  assert.deepEqual(await processMergeRequest(input, sql, github, loadIssue), {
    ok: true, eligible: false, merged: false, reason: "normal_review_approval_required",
    head_sha: head, base_sha: base })
  assert.equal(mergeCalls, 0)
  approvals = 1
  assert.deepEqual(await processMergeRequest(input, sql, github, loadIssue), {
    ok: true, eligible: true, merged: true, review_required: false,
    review_escalated: false, risk_triggers: [],
    head_sha: head, base_sha: base, merge_sha: merge })
  assert.equal(mergeCalls, 1)
})
