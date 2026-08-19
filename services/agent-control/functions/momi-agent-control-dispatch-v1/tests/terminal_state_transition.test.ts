import assert from "node:assert/strict"
import test from "node:test"

import { selectTerminalCompletionState } from "../src/terminal_state_transition.ts"
import type {
  LinearIssueState,
  TerminalContext,
  TerminalInput,
} from "../src/types.ts"

const context = { issue_id: "issue-1", issue_identifier: "MOX-253",
  action: "execute-run", linear_comment_id: null } as TerminalContext
const terminal = { event: "terminal", work_id: "work-1", capability_token: "token-1",
  thread_id: "thread-1", turn_id: "turn-1", readiness_result: "ready",
  terminal_disposition: "completed", archived_at: "2026-08-19T12:00:00Z",
  summary: "Complete." } as TerminalInput

function issue(
  stateType: LinearIssueState["stateRef"]["type"],
  completedIds: string[] = ["done-id"],
): LinearIssueState {
  return { stateRef: { id: `${stateType}-id`, name: stateType, type: stateType },
    teamStates: completedIds.map((id) => ({ id, name: id, type: "completed" }))
  } as LinearIssueState
}

test("successful ready execution selects the unique completed state from active states", () => {
  assert.equal(selectTerminalCompletionState(context, terminal, issue("unstarted")), "done-id")
  assert.equal(selectTerminalCompletionState(context, terminal, issue("started")), "done-id")
})

test("successful execution replay is idempotent once the issue is completed", () => {
  assert.equal(selectTerminalCompletionState(context, terminal, issue("completed", [])), null)
})

test("non-success terminal results and non-execution actions never select a state", () => {
  const cases: Array<[TerminalContext, TerminalInput]> = [
    [context, { ...terminal, readiness_result: "unready" }],
    [context, { ...terminal, readiness_result: "failed" }],
    [context, { ...terminal, terminal_disposition: "failed" }],
    [context, { ...terminal, terminal_disposition: "interrupted" }],
    [{ ...context, action: "validate-issue" }, terminal],
    [{ ...context, action: "run-discovery" }, terminal],
  ]
  for (const [candidateContext, candidateTerminal] of cases) {
    assert.equal(selectTerminalCompletionState(
      candidateContext, candidateTerminal, issue("canceled", [])), null)
  }
})

test("successful execution fails closed from non-active states", () => {
  for (const type of ["backlog", "canceled", "duplicate"] as const) {
    assert.throws(() => selectTerminalCompletionState(context, terminal, issue(type)),
      /linear_terminal_source_state_not_active/, type)
  }
})

test("successful execution fails closed unless the completed state is unique", () => {
  for (const ids of [[], ["done-1", "done-2"]]) {
    assert.throws(() => selectTerminalCompletionState(
      context, terminal, issue("unstarted", ids)), /linear_completed_state_not_unique/)
  }
})
