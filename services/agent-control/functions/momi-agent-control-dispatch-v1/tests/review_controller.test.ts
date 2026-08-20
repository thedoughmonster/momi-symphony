import assert from "node:assert/strict"
import test from "node:test"
import type { Sql } from "postgres"

import { REVIEW_CHECK_NAME, REVIEW_POLICY_VERSION } from "../../../src/independent_review.ts"
import { processMergePreflight, processReviewTerminal } from "../src/review_controller.ts"
import type { MergePreflightInput, ReviewTerminalInput } from "../src/types.ts"

const implementationId = "00000000-0000-4000-8000-000000000001"
const reviewerId = "00000000-0000-4000-8000-000000000002"
const reviewAttemptId = "00000000-0000-4000-8000-000000000003"
const token = "00000000-0000-4000-8000-000000000004"
const repository = "thedoughmonster/momi-symphony"
const head = "a".repeat(40); const base = "b".repeat(40)

test("accepted review remains unprojected until authenticated merge preflight", async () => {
  const published: boolean[] = []
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?")
    if (query.includes("mapped_repository as repository")) return [{ repository }]
    if (query.includes("record_review_result_v1")) return [{ recorded: true }]
    if (query.includes("select state from")) return [{ state: "accepted" }]
    throw new Error(`unexpected_sql:${query}`)
  }) as unknown as Sql
  ;(sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value
  const input = { event: "review_terminal", reviewer_dispatch_id: reviewerId,
    capability_token: token, runtime_role: "independent_reviewer",
    thread_id: "review-thread", turn_id: "review-turn",
    review_subject: { implementation_dispatch_id: implementationId,
      pull_request_number: 16, head_sha: head, base_sha: base, generation: 1,
      profile: "high", policy_version: REVIEW_POLICY_VERSION },
    review_result: { result: "accepted", findings: [], artifact_ref: "review://exact",
      result_fingerprint: `sha256:${"c".repeat(64)}` }, terminal_disposition: "completed",
    archived_at: "2026-08-20T15:00:00.000Z", telemetry: {} } as ReviewTerminalInput
  const github = { publishReviewCheck: async (_repository: string, _head: string,
    success: boolean) => { published.push(success) } }
  assert.equal((await processReviewTerminal(input, sql, github as never,
    async () => "Running" as never)).disposition, "accepted")
  assert.deepEqual(published, [])
})

test("merge preflight persists its exact receipt before projecting the required success check", async () => {
  const timeline: string[] = []
  const subject = { repository, pullRequestNumber: 16, state: "open" as const,
    baseBranch: "main", headSha: head, baseSha: base,
    changedPaths: ["services/agent-control/src/independent_review.ts"],
    riskDimensions: ["architecture" as const], diffArtifactRef: "github://diff" }
  let factsCalls = 0
  const github = { loadSubject: async () => subject,
    loadMergeFacts: async () => {
      factsCalls += 1
      return { baseHeadSha: base, requiredCi: { headSha: head, conclusion: "success" as const },
        reviewCheck: { name: REVIEW_CHECK_NAME, headSha: head,
          conclusion: factsCalls === 1 ? "unknown" as const : "success" as const },
        reviewCheckRequired: true, bypassPossible: false,
        authoritativeBlockingThreads: 0, authoritativeChangesRequested: false }
    }, publishReviewCheck: async (_repository: string, _head: string, success: boolean) => {
      timeline.push(`publish:${success}`)
    } }
  const row = { work_status: "active", cancellation_requested_at: null, cancelled_at: null,
    implementation_thread_id: "implementation-thread", review_attempt_id: reviewAttemptId,
    implementation_dispatch_id: implementationId, reviewer_dispatch_id: reviewerId,
    repository, pull_request_number: 16, head_sha: head, base_sha: base, generation: 1,
    profile: "high", policy_version: REVIEW_POLICY_VERSION,
    reviewer_thread_id: "review-thread", reviewer_turn_id: "review-turn",
    runtime_role: "independent_reviewer", result: "accepted", findings: [],
    artifact_ref: "review://exact", result_fingerprint: `sha256:${"c".repeat(64)}` }
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?")
    if (query.includes("from momi_agent_ops.dispatches work") &&
      query.includes("review.review_attempt_id")) return [row]
    if (query.includes("record_merge_preflight_v1")) {
      timeline.push("record:merge_preflight"); return [{ recorded: true }]
    }
    if (query.includes("record_review_check_v1")) {
      timeline.push("record:review_check"); return [{ recorded: true }]
    }
    if (query.includes("merge_review_eligible_v1")) return [{ eligible: true }]
    throw new Error(`unexpected_sql:${query}`)
  }) as unknown as Sql
  const input: MergePreflightInput = { event: "merge_preflight", work_id: implementationId,
    capability_token: token, thread_id: "implementation-thread", turn_id: "implementation-turn",
    repository, base_branch: "main", pull_request_number: 16 }
  const result = await processMergePreflight(input, sql, github as never)
  assert.equal(result.eligible, true)
  assert.deepEqual(timeline, ["record:merge_preflight", "publish:true", "record:review_check"])
})
