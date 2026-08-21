import assert from "node:assert/strict"
import test from "node:test"

import { interruptSupersededReviews } from "../src/interrupt_superseded_reviews.ts"

const input = { event: "lifecycle_evidence" as const,
  work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002",
  thread_id: "implementation-thread", turn_id: "implementation-turn",
  repository: "thedoughmonster/momi-symphony", base_branch: "main",
  branch_name: "feature", pull_request_number: 16,
  phase: "validating" as const, status: "succeeded" as const,
  previous_revision_sha: null, revision_sha: "a".repeat(40), workflow_run_id: "123" }

test("new-head cancellation triggers best-effort reviewer interruption without receipts", async () => {
  const originalDeno = (globalThis as Record<string, unknown>).Deno
  ;(globalThis as Record<string, unknown>).Deno = { env: { get: () => "host-secret" } }
  const reviewerId = "00000000-0000-4000-8000-000000000003"
  let requested = false
  try {
    await interruptSupersededReviews(input, (async () => [{
      reviewer_dispatch_id: reviewerId,
      host_dispatch_url: "https://host.example/v1/dispatch",
    }]) as never, async (_url, init) => {
      requested = true
      assert.deepEqual(JSON.parse(String(init?.body)).target_work_ids, [reviewerId])
      throw new Error("offline")
    })
    assert.equal(requested, true)
  } finally {
    if (originalDeno === undefined) delete (globalThis as Record<string, unknown>).Deno
    else (globalThis as Record<string, unknown>).Deno = originalDeno
  }
})
