import assert from "node:assert/strict"
import test from "node:test"

import { deriveAgentState } from "../src/agent_state.ts"
import type { AgentStateEvidence } from "../src/agent_state.ts"

function evidence(overrides: Partial<AgentStateEvidence> = {}): AgentStateEvidence {
  return {
    lifecycle_version: "agent-state-v2",
    dispatch_id: "00000000-0000-4000-8000-000000000001",
    current_dispatch_id: "00000000-0000-4000-8000-000000000001",
    action: "execute-run", source_kind: "ready_leaf_scheduler", work_status: "pending",
    attempt_count: 0, last_error_code: null, host_accepted_at: null,
    cancellation_state: "not_requested", cancelled_at: null, readiness_result: "pending",
    terminal_disposition: null, terminal_at: null, execution_status: "pending",
    linear_projection_status: "pending",
    validation_state: "not_required", validation_sha: null,
    current_review_state: "not_required", current_review_sha: null,
    release_state: "not_required", release_sha: null,
    head_sha: null, merge_sha: null, has_active_children: false,
    ...overrides,
  }
}

test("scheduler, claim, host, and child evidence derive without a model turn", () => {
  assert.equal(deriveAgentState(evidence()), "queued")
  assert.equal(deriveAgentState(evidence({ work_status: "claimed", attempt_count: 1 })), "checking")
  assert.equal(deriveAgentState(evidence({ work_status: "active",
    host_accepted_at: "2026-08-20T12:00:00Z" })), "working")
  assert.equal(deriveAgentState(evidence({ work_status: "active",
    host_accepted_at: "2026-08-20T12:00:00Z", has_active_children: true })), "coordinating")
})

test("exact delivery receipts drive validating, reviewing, and releasing", () => {
  const head = "a".repeat(40)
  const merge = "b".repeat(40)
  assert.equal(deriveAgentState(evidence({ work_status: "active", head_sha: head,
    validation_state: "running", validation_sha: head })), "validating")
  assert.equal(deriveAgentState(evidence({ work_status: "active", head_sha: head,
    validation_state: "succeeded", validation_sha: head,
    current_review_state: "pending", current_review_sha: head })), "reviewing")
  assert.equal(deriveAgentState(evidence({ work_status: "active", head_sha: head,
    merge_sha: merge, validation_state: "succeeded", validation_sha: head,
    current_review_state: "succeeded", current_review_sha: head,
    release_state: "running", release_sha: merge })), "releasing")
})

test("review rework resumes working while inconclusive evidence waits", () => {
  const head = "a".repeat(40)
  assert.equal(deriveAgentState(evidence({ head_sha: head,
    current_review_state: "changes_requested", current_review_sha: head,
    work_status: "active" })), "working")
  assert.equal(deriveAgentState(evidence({ head_sha: head,
    current_review_state: "inconclusive", current_review_sha: head,
    work_status: "active" })), "waiting")
})

test("terminal state requires durable execution but not its Linear projection", () => {
  const terminal = { work_status: "completed" as const, readiness_result: "ready",
    terminal_disposition: "completed" as const, terminal_at: "2026-08-20T12:00:00Z",
    execution_status: "succeeded" as const }
  assert.equal(deriveAgentState(evidence(terminal)), "complete")
  assert.equal(deriveAgentState(evidence({ ...terminal,
    linear_projection_status: "retryable" })), "complete")
  const head = "a".repeat(40)
  assert.equal(deriveAgentState(evidence({ ...terminal,
    head_sha: head,
    validation_state: "pending", validation_sha: head })), "validating")
})

test("retry, exhausted failure, and cancellation are exceptional states", () => {
  assert.equal(deriveAgentState(evidence({ attempt_count: 2,
    last_error_code: "tracker_timeout" })), "waiting")
  assert.equal(deriveAgentState(evidence({ work_status: "dead_letter" })), "failed")
  assert.equal(deriveAgentState(evidence({ work_status: "cancelled",
    cancelled_at: "2026-08-20T12:00:00Z" })), "stopped")
  assert.equal(deriveAgentState(evidence({ work_status: "active",
    terminal_disposition: "interrupted" })), "working")
  assert.equal(deriveAgentState(evidence({ work_status: "completed",
    terminal_disposition: "interrupted", terminal_at: "2026-08-20T12:00:00Z" })), "stopped")
})

test("stale generations and unrelated delivery revisions fail closed", () => {
  assert.throws(() => deriveAgentState(evidence({ current_dispatch_id:
    "00000000-0000-4000-8000-000000000002" })), /generation_stale/)
  assert.throws(() => deriveAgentState(evidence({ head_sha: "a".repeat(40),
    validation_state: "running", validation_sha: "b".repeat(40) })),
  /validation_revision_mismatch/)
})
