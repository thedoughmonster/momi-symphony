import { buildLinearComment } from "./build_linear_comment.ts"
import { loadLinearIssue } from "./load_linear_issue.ts"
import type { ClaimedDispatch } from "./types.ts"
import { writeLinearComment } from "./write_linear_comment.ts"
import { writeLinearLabels } from "./write_linear_labels.ts"

export async function reconcileLinear(work: ClaimedDispatch): Promise<string> {
  const issue = await loadLinearIssue(work.issue_id)
  if (issue.identifier !== work.issue_identifier) throw new Error("linear_issue_identity_conflict")
  const action = issue.teamLabels.find((label) => label.name === work.action)
  const hasRun = issue.teamLabels.find((label) => label.name === "has-run")
  if (!action || (!work.rejection_code && !hasRun)) {
    throw new Error("linear_action_labels_unavailable")
  }
  const labels = issue.labels.filter((label) => label.id !== action.id)
  if (!work.rejection_code && hasRun && !labels.some((label) => label.id === hasRun.id)) {
    labels.push(hasRun)
  }
  await writeLinearLabels(issue.id, labels.map((label) => label.id).sort())
  const marker = `momi-agent-control:${work.work_id}`
  return writeLinearComment(issue, marker, buildLinearComment(work), work.linear_comment_id)
}
