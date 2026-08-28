import type { LinearIssueState, TerminalContext, TerminalProjectionInput } from "./types.ts"

export function selectTerminalCompletionState(
  context: TerminalContext,
  terminal: TerminalProjectionInput,
  issue: LinearIssueState,
): string | null {
  const shouldComplete = context.action === "execute-run" &&
    terminal.readiness_result === "ready" &&
    terminal.terminal_disposition === "completed"
  if (!shouldComplete || issue.stateRef.type === "completed") return null
  if (!["unstarted", "started"].includes(issue.stateRef.type)) {
    throw new Error("linear_terminal_source_state_not_active")
  }
  const completed = issue.teamStates.filter((state) => state.type === "completed")
  if (completed.length !== 1) throw new Error("linear_completed_state_not_unique")
  return completed[0].id
}
