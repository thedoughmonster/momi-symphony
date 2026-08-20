import { buildLinearComment } from "./build_linear_comment.ts"
import { loadLinearIssue } from "./load_linear_issue.ts"
import type { ClaimedDispatch, TerminalContext, TerminalInput } from "./types.ts"
import { selectTerminalCompletionState } from "./terminal_state_transition.ts"
import { writeLinearComment } from "./write_linear_comment.ts"
import { writeLinearCompletion, writeLinearLabels } from "./write_linear_labels.ts"

export async function reconcileTerminal(
  context: TerminalContext,
  terminal: TerminalInput,
): Promise<string> {
  const issue = await loadLinearIssue(context.issue_id)
  if (issue.identifier !== context.issue_identifier) {
    throw new Error("linear_issue_identity_conflict")
  }
  const labelIds = issue.labelRefs
    .filter((label) => label.name !== context.action && label.name !== "has-run")
    .map((label) => label.id).sort()
  const completionStateId = selectTerminalCompletionState(context, terminal, issue)
  if (completionStateId) {
    await writeLinearCompletion(issue.id, labelIds, completionStateId)
  } else {
    await writeLinearLabels(issue.id, labelIds)
  }
  const work = { work_id: terminal.work_id, issue_id: context.issue_id,
    issue_identifier: context.issue_identifier, action: context.action,
    issue_url: "", project_id: null,
    project_name: null, repository: null, base_branch: null, active_states: null,
    host_dispatch_url: null,
    rejection_code: null, delivery_phase: "writeback", thread_id: terminal.thread_id,
    turn_id: terminal.turn_id, linear_comment_id: context.linear_comment_id,
    parent_dispatch_id: null, target_dispatch_id: null,
    cancellation_target_ids: [], source_kind: "linear_action",
    validation_profile: "normal",
    cancellation_state: "not_requested", recovery_state: "not_requested" } as ClaimedDispatch
  return writeLinearComment(issue, `momi-agent-control:${terminal.work_id}`,
    buildLinearComment(work, terminal), context.linear_comment_id)
}
