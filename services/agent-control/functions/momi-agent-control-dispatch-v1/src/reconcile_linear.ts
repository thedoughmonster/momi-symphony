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
  // The durable dispatch, not a bookkeeping label, is execution evidence. A
  // scheduler-origin run never had an execute-run label, and historical
  // has-run assignments are removed opportunistically on every fresh read.
  const labelIds = issue.labelRefs
    .filter((label) => label.name !== work.action && label.name !== "has-run")
    .map((label) => label.id).sort()
  const currentIds = issue.labelRefs.map((label) => label.id).sort()
  if (labelIds.join("\n") !== currentIds.join("\n")) {
    await writeLinearLabels(issue.id, labelIds)
  }
  const marker = `momi-agent-control:${work.work_id}`
  return writeLinearComment(issue, marker, buildLinearComment(work), work.linear_comment_id)
}
