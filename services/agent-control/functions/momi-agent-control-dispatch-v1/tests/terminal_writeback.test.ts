import assert from "node:assert/strict"
import test from "node:test"

import { processTerminal } from "../src/process_terminal.ts"
import type { TerminalInput } from "../src/types.ts"

const terminal: TerminalInput = { event: "terminal",
  work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002",
  thread_id: "thread-1", turn_id: "turn-1", readiness_result: "ready",
  terminal_disposition: "completed", archived_at: "2026-08-14T12:00:00.000Z",
  summary: "Merged to dev; deployment pending." }

test("terminal completion persists before its Linear projection", async () => {
  const result = await processTerminal(terminal,
    () => Promise.resolve({ issue_id: "issue-1", issue_identifier: "MOX-151",
      action: "cleanup", linear_comment_id: null }),
    () => Promise.resolve({ claimed: true, status: "succeeded" }))
  assert.deepEqual(result, { ok: true, disposition: "completed",
    execution_status: "succeeded", projection_status: "succeeded" })
})

test("a Linear outage is visible and does not fail completed execution", async () => {
  const result = await processTerminal(terminal,
    () => Promise.resolve({ issue_id: "issue-1", issue_identifier: "MOX-151",
      action: "cleanup", linear_comment_id: null }),
    () => Promise.resolve({ claimed: true, status: "retryable" }))
  assert.deepEqual(result, { ok: true, disposition: "completed",
    execution_status: "succeeded", projection_status: "retryable" })
})

test("an unbound terminal callback remains retryable", async () => {
  await assert.rejects(processTerminal(terminal, () => Promise.resolve(null),
    () => Promise.resolve({ claimed: false, status: "skipped" })),
  /terminal_record_refused/)
})
