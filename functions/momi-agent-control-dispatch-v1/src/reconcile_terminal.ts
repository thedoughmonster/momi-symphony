import { buildLinearComment } from "./build_linear_comment.ts"
import { loadLinearIssue } from "./load_linear_issue.ts"
import type { ClaimedDispatch, TerminalContext, TerminalInput } from "./types.ts"
import { writeLinearComment } from "./write_linear_comment.ts"
import { writeLinearLabels } from "./write_linear_labels.ts"

export async function reconcileTerminal(
  context: TerminalContext,
  terminal: TerminalInput,
): Promise<string> {
  const issue = await loadLinearIssue(context.issue_id)
  if (issue.identifier !== context.issue_identifier) {
    throw new Error("linear_issue_identity_conflict")
  }
  const action = issue.teamLabels.find((label) => label.name === context.action)
  const hasRun = issue.teamLabels.find((label) => label.name === "has-run")
  if (!action || !hasRun) throw new Error("linear_action_labels_unavailable")
  const labels = issue.labels.filter((label) => label.id !== action.id)
  if (!labels.some((label) => label.id === hasRun.id)) labels.push(hasRun)
  await writeLinearLabels(issue.id, labels.map((label) => label.id).sort())
  const work = { work_id: terminal.work_id, issue_id: context.issue_id,
    issue_identifier: context.issue_identifier, action: context.action,
    issue_url: "", project_id: null,
    project_name: null, repository: null, base_branch: null, active_states: null,
    rejection_code: null, delivery_phase: "writeback", thread_id: terminal.thread_id,
    turn_id: terminal.turn_id, linear_comment_id: context.linear_comment_id } as ClaimedDispatch
  return writeLinearComment(issue, `momi-agent-control:${terminal.work_id}`,
    buildLinearComment(work, terminal), context.linear_comment_id)
}
