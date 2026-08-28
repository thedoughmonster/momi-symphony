import assert from "node:assert/strict"
import test from "node:test"

import { processProjectionReplay } from "../src/process_projection_replay.ts"
import { processTerminalProjection } from "../src/terminal_projection.ts"
import type { TerminalProjectionContext } from "../src/types.ts"

const dispatchId = "00000000-0000-4000-8000-000000000001"
const context: TerminalProjectionContext = {
  work_id: dispatchId, issue_id: "00000000-0000-4000-8000-000000000002",
  issue_identifier: "MOX-431", action: "execute-run", linear_comment_id: null,
  thread_id: "thread-1", turn_id: "turn-1",
  readiness_result: "ready", terminal_disposition: "completed",
  summary: "Implementation completed.", archived_at: "2026-08-28T19:00:00Z",
}

test("failure injection records a retry without re-executing completed code", async () => {
  const results: Array<[boolean, string | null, string | null]> = []
  let reconciles = 0
  const result = await processTerminalProjection(dispatchId, {
    claim: () => Promise.resolve(context),
    reconcile: () => { reconciles += 1; return Promise.reject(new Error("linear_outage")) },
    projectState: () => Promise.resolve(),
    recordResult: (_id, succeeded, commentId, code) => {
      results.push([succeeded, commentId, code]); return Promise.resolve("retryable")
    },
  })
  assert.deepEqual(result, { claimed: true, status: "retryable" })
  assert.equal(reconciles, 1)
  assert.deepEqual(results, [[false, null, "linear_outage"]])
})

test("reconciliation retry reuses durable terminal evidence and then succeeds", async () => {
  let reconciles = 0
  const statuses: Array<"retryable" | "succeeded"> = ["retryable", "succeeded"]
  const dependencies = {
    claim: () => Promise.resolve(context),
    reconcile: () => {
      reconciles += 1
      return reconciles === 1 ? Promise.reject(new Error("linear_outage"))
        : Promise.resolve("00000000-0000-4000-8000-000000000003")
    },
    projectState: () => Promise.resolve(),
    recordResult: () => Promise.resolve(statuses.shift() ?? "succeeded"),
  }
  assert.equal((await processTerminalProjection(dispatchId, dependencies)).status, "retryable")
  assert.equal((await processTerminalProjection(dispatchId, dependencies)).status, "succeeded")
  assert.equal(reconciles, 2)
})

test("manual replay is explicit, bounded by parsing, and projection-only", async () => {
  const requeued: string[] = []
  const receipt = await processProjectionReplay({ event: "projection_replay",
    dispatch_ids: [dispatchId] },
  (id) => { requeued.push(id); return Promise.resolve(true) },
  () => Promise.resolve({ claimed: true, status: "succeeded" }))
  assert.deepEqual(requeued, [dispatchId])
  assert.deepEqual(receipt, { ok: true, requested: 1, claimed: 1,
    succeeded: 1, retryable: 0, failed: 0, skipped: 0 })
})
