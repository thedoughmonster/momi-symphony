import assert from "node:assert/strict"
import test from "node:test"

import { parseDispatchInput } from "../src/parse_dispatch_input.ts"
import { processLifecycleEvidence } from "../src/process_lifecycle_evidence.ts"
import type { LifecycleEvidenceInput } from "../src/types.ts"

const input: LifecycleEvidenceInput = {
  event: "lifecycle_evidence",
  work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002",
  thread_id: "thread-1", turn_id: "turn-1",
  repository: "thedoughmonster/momi-symphony", base_branch: "main",
  branch_name: "mox-258-agent-state-lifecycle", pull_request_number: 14,
  phase: "validating", status: "running", previous_revision_sha: null,
  revision_sha: "a".repeat(40),
  workflow_run_id: "1234",
}

test("lifecycle receipts are strict and exact-revision shaped", () => {
  assert.deepEqual(parseDispatchInput(input), input)
  assert.equal(parseDispatchInput({ ...input, unrelated: true }), null)
  assert.equal(parseDispatchInput({ ...input, revision_sha: "b".repeat(39) }), null)
  assert.equal(parseDispatchInput({ ...input, previous_revision_sha: "b".repeat(39) }), null)
  assert.equal(parseDispatchInput({ ...input, phase: "releasing",
    merge_sha: "b".repeat(40) }), null)
  const release = { ...input, phase: "releasing" as const,
    revision_sha: "b".repeat(40), merge_sha: "b".repeat(40) }
  assert.deepEqual(parseDispatchInput(release), release)
})

test("a durable receipt is recorded before projection", async () => {
  const order: string[] = []
  assert.deepEqual(await processLifecycleEvidence(input,
    () => { order.push("record"); return Promise.resolve(true) },
    () => { order.push("project"); return Promise.resolve() }, undefined,
    () => { order.push("interrupt"); return Promise.resolve() }),
  { ok: true, disposition: "recorded" })
  assert.deepEqual(order, ["record", "interrupt", "project"])
  await assert.rejects(processLifecycleEvidence(input,
    () => Promise.resolve(false), () => Promise.reject(new Error("must_not_project"))),
  /record_refused/)
})

test("focused validation success automatically enters independent review", async () => {
  const order: string[] = []
  const result = await processLifecycleEvidence({ ...input, status: "succeeded" },
    () => { order.push("record"); return Promise.resolve(true) },
    () => { order.push("project"); return Promise.resolve() },
    (review) => { order.push("review"); assert.equal(review.event, "review_request")
      assert.equal(review.pull_request_number, input.pull_request_number)
      return Promise.resolve({ disposition: "accepted" }) },
    () => { order.push("interrupt"); return Promise.resolve() })
  assert.deepEqual(order, ["record", "interrupt", "project", "review"])
  assert.deepEqual(result, { ok: true, disposition: "recorded",
    review: { disposition: "accepted" } })
})

test("implementation callbacks cannot submit review-phase lifecycle evidence", () => {
  assert.equal(parseDispatchInput({ ...input, phase: "reviewing" }), null)
})

test("review terminal callbacks require exact nested subject and result schemas", () => {
  const telemetry = { policy_version: "independent-review-v1",
    stable_prefix_fingerprint: "fnv1a64:1111111111111111",
    context_fingerprint: "fnv1a64:2222222222222222", input_tokens: null,
    cached_input_tokens: null, output_tokens: null, model_visible_tool_bytes: 1,
    model_turns: 1, no_progress_cycles: 0, subagents: 0, max_subagent_depth: 0,
    retries: 0, repeated_failure_fingerprints: 0, elapsed_ms: 1,
    disposition: "completed" }
  const review = { event: "review_terminal",
    reviewer_dispatch_id: "00000000-0000-4000-8000-000000000011",
    capability_token: "00000000-0000-4000-8000-000000000012",
    runtime_role: "independent_reviewer", thread_id: "review-thread", turn_id: "review-turn",
    review_subject: { implementation_dispatch_id: input.work_id, pull_request_number: 16,
      head_sha: "a".repeat(40), base_sha: "b".repeat(40), generation: 1,
      profile: "high", model: "gpt-5.6-sol", reasoning_effort: "high",
      policy_version: "independent-review-v1" },
    review_result: { result: "changes_requested", findings: [{ id: "finding-1",
      severity: "blocking", category: "correctness", path: "src/review.ts", line: 10,
      contract: "Bind the exact source.", required_outcome: "Reject mismatched evidence.",
      evidence: "A mismatched source was accepted." }], artifact_ref: "review://attempt/1",
      result_fingerprint: `sha256:${"1".repeat(64)}` }, terminal_disposition: "completed",
    archived_at: "2026-08-20T15:00:00.000Z", telemetry }
  assert.deepEqual(parseDispatchInput(review), review)
  assert.equal(parseDispatchInput({ ...review, review_subject: {
    ...review.review_subject, extra: true } }), null)
  assert.equal(parseDispatchInput({ ...review, review_result: {
    ...review.review_result, artifact_ref: "" } }), null)
  assert.equal(parseDispatchInput({ ...review, review_result: { ...review.review_result,
    findings: [{ ...review.review_result.findings[0], path: "src\\review.ts" }] } }), null)
  assert.equal(parseDispatchInput({ ...review, terminal_disposition: "interrupted" }), null)
  assert.notEqual(parseDispatchInput({ ...review, terminal_disposition: "interrupted",
    review_result: null, telemetry: { ...telemetry, disposition: "interrupted" } }), null)
})
