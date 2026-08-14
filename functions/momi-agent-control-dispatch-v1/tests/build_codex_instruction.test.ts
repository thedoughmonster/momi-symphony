import assert from "node:assert/strict"
import test from "node:test"

import { buildCodexInstruction } from "../src/build_codex_instruction.ts"
import type { ClaimedDispatch } from "../src/types.ts"

test("the surfaced task owns validated merge and development release", () => {
  const work = { issue_identifier: "MOX-151", issue_url: "https://linear/MOX-151",
    project_id: "project", project_name: "Backend Stabilization",
    repository: "thedoughmonster/momi-backend", base_branch: "dev",
    active_states: ["Todo"], work_id: "work", issue_id: "issue",
    rejection_code: null, delivery_phase: "host", thread_id: null,
    turn_id: null, linear_comment_id: null } as ClaimedDispatch
  const instruction = buildCodexInstruction(work)
  assert.match(instruction, /merge to dev/)
  assert.match(instruction, /required checks and feedback resolution/)
  assert.match(instruction, /repository-authorized development release/)
  assert.match(instruction, /execute-run never authorizes production deployment/)
  assert.match(instruction, /separate explicit user instruction/)
  assert.doesNotMatch(instruction, /do not merge/)
})

test("a consumed execute-run label does not invalidate the accepted task", () => {
  const work = { issue_identifier: "MOX-152", issue_url: "https://linear/MOX-152",
    project_id: "project", project_name: "Backend Stabilization",
    repository: "thedoughmonster/momi-backend", base_branch: "dev",
    active_states: ["Todo", "In Progress", "Rework"], work_id: "work",
    issue_id: "issue", rejection_code: null, delivery_phase: "host",
    thread_id: null, turn_id: null, linear_comment_id: null } as ClaimedDispatch
  const instruction = buildCodexInstruction(work)
  assert.match(instruction, /durable proof that execute-run was added/)
  assert.match(instruction, /absence must not make the issue unready/)
  assert.doesNotMatch(instruction, /execute-run is still present/)
})

test("follow-on issues are not constrained by the bootstrap issue scope", () => {
  const work = { issue_identifier: "MOX-153", issue_url: "https://linear/MOX-153",
    project_id: "project", project_name: "Backend Stabilization",
    repository: "thedoughmonster/momi-backend", base_branch: "dev",
    active_states: ["Todo"], work_id: "work", issue_id: "issue",
    rejection_code: null, delivery_phase: "host", thread_id: null,
    turn_id: null, linear_comment_id: null } as ClaimedDispatch
  const instruction = buildCodexInstruction(work)
  assert.match(instruction, /named issue's bounded scope/)
  assert.match(instruction, /do not hand its implementation to Symphony/)
  assert.doesNotMatch(instruction, /Do not implement other action labels/)
  assert.doesNotMatch(instruction, /parent runs, or cancellation/)
})
