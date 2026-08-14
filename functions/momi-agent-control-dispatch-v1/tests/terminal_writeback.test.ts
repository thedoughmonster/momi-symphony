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

test("terminal completion persists reconciled Linear evidence", async () => {
  let recordedComment: string | null = null
  const result = await processTerminal(terminal,
    () => Promise.resolve({ issue_id: "issue-1", issue_identifier: "MOX-151",
      linear_comment_id: null }),
    () => Promise.resolve("comment-1"),
    (_input, commentId) => { recordedComment = commentId; return Promise.resolve(true) })
  assert.deepEqual(result, { ok: true, disposition: "completed" })
  assert.equal(recordedComment, "comment-1")
})

test("an unbound terminal callback remains retryable", async () => {
  await assert.rejects(processTerminal(terminal, () => Promise.resolve(null),
    () => Promise.resolve("comment-1"), () => Promise.resolve(true)),
  /terminal_record_refused/)
})
