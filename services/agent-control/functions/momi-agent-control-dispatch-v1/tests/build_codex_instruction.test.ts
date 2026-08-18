import assert from "node:assert/strict"
import test from "node:test"

import type { AgentAction } from "../../../src/actions.ts"
import { buildCodexInstruction } from "../src/build_codex_instruction.ts"
import type { ClaimedDispatch } from "../src/types.ts"

const baseWork = { issue_identifier: "MOX-152", issue_url: "https://linear/MOX-152",
  project_id: "project", project_name: "Backend Stabilization",
  repository: "thedoughmonster/momi-backend", base_branch: "dev",
  active_states: ["Todo", "In Progress", "Rework"], work_id: "work", issue_id: "issue",
  host_dispatch_url: "https://codex-host.example/v1/dispatch", rejection_code: null,
  delivery_phase: "host", thread_id: null, turn_id: null,
  linear_comment_id: null } as const

test("execute-run owns validated merge and development release", () => {
  const instruction = buildCodexInstruction({ ...baseWork,
    action: "execute-run" } as ClaimedDispatch)
  assert.match(instruction, /draft PR/)
  assert.match(instruction, /required checks and feedback resolution/)
  assert.match(instruction, /repository-authorized development release/)
  assert.match(instruction, /durable proof that execute-run was added/)
  assert.match(instruction, /When direct children exist/)
  assert.match(instruction, /Durable dispatch: work/)
  assert.match(instruction, /absence must not make the issue unready/)
  assert.match(instruction, /Never invoke Symphony/)
  assert.match(instruction, /separate explicit approval/)
})

test("cancel-run never creates implementation work", () => {
  const instruction = buildCodexInstruction({ ...baseWork,
    action: "cancel-run" } as ClaimedDispatch)
  assert.match(instruction, /Do not implement or create a task/)
  assert.doesNotMatch(instruction, /draft PR/)
})

test("each non-execution action has a distinct bounded route", () => {
  const expectations: Array<[AgentAction, RegExp]> = [
    ["validate-issue", /deterministic readiness check/],
    ["investigate-issue", /evidence-backed investigation/],
    ["cleanup", /Linear metadata and stale run bookkeeping/],
    ["decompose", /executable child issues/],
    ["run-discovery", /persistent interactive discovery task/],
  ]
  for (const [action, expected] of expectations) {
    const instruction = buildCodexInstruction({ ...baseWork, action } as ClaimedDispatch)
    assert.match(instruction, expected)
    assert.match(instruction, new RegExp(`durable proof that ${action} was added`))
    assert.match(instruction, /Never invoke Symphony/)
    assert.doesNotMatch(instruction, /draft PR/)
  }
})

test("discovery asks one question and does not request structured terminal output", () => {
  const instruction = buildCodexInstruction({ ...baseWork,
    action: "run-discovery" } as ClaimedDispatch)
  assert.match(instruction, /ask one concise high-value question/)
  assert.match(instruction, /task remains open/)
  assert.doesNotMatch(instruction, /Return only the requested structured/)
})
