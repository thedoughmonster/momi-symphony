import { linearGraphql } from "./linear_graphql.ts"
import type { LinearIssueState } from "./types.ts"

export async function writeLinearComment(
  issue: LinearIssueState,
  marker: string,
  body: string,
  knownId: string | null,
): Promise<string> {
  const existing = knownId ?? issue.comments.find((comment) => comment.body.includes(marker))?.id
  if (existing) {
    const data = await linearGraphql<{ commentUpdate: { success: boolean; comment: { id: string } } }>(
      `mutation AgentControlCommentUpdate($id: String!, $body: String!) {
        commentUpdate(id: $id, input: { body: $body }) { success comment { id } }
      }`, { id: existing, body },
    )
    if (!data.commentUpdate.success) throw new Error("linear_comment_update_failed")
    return data.commentUpdate.comment.id
  }
  const data = await linearGraphql<{ commentCreate: { success: boolean; comment: { id: string } } }>(
    `mutation AgentControlCommentCreate($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
    }`, { issueId: issue.id, body },
  )
  if (!data.commentCreate.success) throw new Error("linear_comment_create_failed")
  return data.commentCreate.comment.id
}
