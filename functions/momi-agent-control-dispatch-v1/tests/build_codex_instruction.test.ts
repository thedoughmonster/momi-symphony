import assert from "node:assert/strict"
import test from "node:test"

import { buildCodexInstruction } from "../src/build_codex_instruction.ts"
import type { ClaimedDispatch } from "../src/types.ts"

test("the surfaced task owns validated merge but never deployment", () => {
  const work = { issue_identifier: "MOX-151", issue_url: "https://linear/MOX-151",
    project_id: "project", project_name: "Backend Stabilization",
    repository: "thedoughmonster/momi-backend", base_branch: "dev",
    active_states: ["Todo"], work_id: "work", issue_id: "issue",
    rejection_code: null, delivery_phase: "host", thread_id: null,
    turn_id: null, linear_comment_id: null } as ClaimedDispatch
  const instruction = buildCodexInstruction(work)
  assert.match(instruction, /merge to dev/)
  assert.match(instruction, /required checks pass and review feedback is resolved/)
  assert.match(instruction, /do not deploy/)
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
