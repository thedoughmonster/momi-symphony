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
  phase: "validating", status: "running", revision_sha: "a".repeat(40),
  workflow_run_id: "1234",
}

test("lifecycle receipts are strict and exact-revision shaped", () => {
  assert.deepEqual(parseDispatchInput(input), input)
  assert.equal(parseDispatchInput({ ...input, unrelated: true }), null)
  assert.equal(parseDispatchInput({ ...input, revision_sha: "b".repeat(39) }), null)
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
    () => { order.push("project"); return Promise.resolve() }),
  { ok: true, disposition: "recorded" })
  assert.deepEqual(order, ["record", "project"])
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
      return Promise.resolve({ disposition: "accepted" }) })
  assert.deepEqual(order, ["record", "project", "review"])
  assert.deepEqual(result, { ok: true, disposition: "recorded",
    review: { disposition: "accepted" } })
})

test("implementation callbacks cannot submit review-phase lifecycle evidence", () => {
  assert.equal(parseDispatchInput({ ...input, phase: "reviewing" }), null)
})
