import assert from "node:assert/strict"
import test from "node:test"

import { buildLinearComment } from "../src/build_linear_comment.ts"
import type { ClaimedDispatch, TerminalInput } from "../src/types.ts"

const work = { work_id: "00000000-0000-4000-8000-000000000001",
  issue_id: "issue", issue_identifier: "MOX-159", action: "run-discovery",
  issue_url: "https://linear.app/issue", project_id: "project",
  project_name: "Backend Stabilization", repository: "thedoughmonster/momi-backend",
  base_branch: "dev", active_states: ["In Progress"], host_dispatch_url: "https://host",
  rejection_code: null, delivery_phase: "writeback", thread_id: "thread-1",
  turn_id: "turn-1", linear_comment_id: null, parent_dispatch_id: null,
  target_dispatch_id: null, cancellation_state: "not_requested" } as ClaimedDispatch

test("interactive discovery uses one concise mutable status comment", () => {
  const active = buildLinearComment(work)
  assert.match(active, /Discovery active · continue in Codex task/)
  assert.doesNotMatch(active, /Dispatch:|Recorded at:|Final disposition:/)
  const terminal = { event: "terminal", work_id: work.work_id,
    capability_token: "00000000-0000-4000-8000-000000000002",
    thread_id: "thread-1", turn_id: "turn-1", readiness_result: "ready",
    terminal_disposition: "completed", archived_at: "2026-08-15T12:00:00.000Z",
    summary: "Interactive discovery task archived." } as TerminalInput
  assert.match(buildLinearComment(work, terminal),
    /Discovery stopped · Interactive discovery task archived\./)
})

test("discovery recovery comments are concise and hide private identities", () => {
  const recovery = { ...work, action: "recover-discovery", recovery_state: "requested",
    target_dispatch_id: "private-target", thread_id: null, turn_id: null } as ClaimedDispatch
  const pending = buildLinearComment(recovery)
  assert.match(pending, /Recovery pending/i)
  assert.doesNotMatch(pending, /private-target|thread|dispatch/i)
  const done = buildLinearComment({ ...recovery, recovery_state: "recovered" })
  assert.match(done, /Recovery complete/i)
})
