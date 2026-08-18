import { buildLinearComment } from "./build_linear_comment.ts"
import { createLinearAdapterProfile } from "./linear_issue_adapter.ts"
import { loadLinearIssue } from "./load_linear_issue.ts"
import type { ClaimedDispatch } from "./types.ts"
import { writeLinearComment } from "./write_linear_comment.ts"
import { writeLinearLabels } from "./write_linear_labels.ts"

export async function reconcileLinear(work: ClaimedDispatch): Promise<string> {
  const issue = await loadLinearIssue(work.issue_id, createLinearAdapterProfile({
    projectId: work.project_id,
    repository: work.repository,
    baseBranch: work.base_branch,
  }))
  if (issue.identifier !== work.issue_identifier) throw new Error("linear_issue_identity_conflict")
  const action = issue.teamLabels.find((label) => label.name === work.action)
  const hasRun = issue.teamLabels.find((label) => label.name === "has-run")
  const needsRunMarker = !["cancel-run", "recover-discovery"].includes(work.action) &&
    !work.rejection_code
  if (!action || (needsRunMarker && !hasRun)) {
    throw new Error("linear_action_labels_unavailable")
  }
  const labels = issue.labelRefs.filter((label) => label.id !== action.id)
  if (needsRunMarker && hasRun && !labels.some((label) => label.id === hasRun.id)) {
    labels.push(hasRun)
  }
  await writeLinearLabels(issue.id, labels.map((label) => label.id).sort())
  const marker = `momi-agent-control:${work.work_id}`
  return writeLinearComment(issue, marker, buildLinearComment(work), work.linear_comment_id)
}
