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

test("profile escalation is a generic one-step promotion", () => {
  assert.equal(promoteReviewProfile("low"), "standard")
  assert.equal(promoteReviewProfile("standard"), "high")
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
    if (query.includes("lock_current_review_subject_v1")) return [{ locked: true }]
    if (query.includes("host_callback_token_hash")) return [{ work_status: "active",
      cancellation_requested_at: null, cancelled_at: null }]
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
    diffArtifactRef: "github://diff" }), loadMergeFacts: () => Promise.resolve({
      baseHeadSha: base, requiredCi: { headSha: head, conclusion: "success" },
      reviewCheck: { name: REVIEW_CHECK_NAME, headSha: head, conclusion: "success" },
      reviewCheckRequired: true, bypassPossible: false, authoritativeBlockingThreads: 0,
      authoritativeChangesRequested: false }), mergePullRequest: () =>
        Promise.resolve({ merged: true, sha: merge }) } as unknown as GitHubReviewGateway
  const input: MergeRequestInput = { event: "merge_request", work_id: implementationId,
    capability_token: capability, thread_id: "implementation-thread",
    turn_id: "implementation-turn", repository, base_branch: "main", pull_request_number: 16 }
  assert.deepEqual(await processMergeRequest(input, sql, github), { ok: true, eligible: true,
    merged: true, head_sha: head, base_sha: base, merge_sha: merge })
})
