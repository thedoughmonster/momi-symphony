import { linearGraphql } from "./linear_graphql.ts"

export async function writeLinearLabels(issueId: string, labelIds: string[]): Promise<void> {
  const data = await linearGraphql<{ issueUpdate: { success: boolean } }>(
    `mutation AgentControlLabels($id: String!, $labelIds: [String!]!) {
      issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
    }`,
    { id: issueId, labelIds },
  )
  if (!data.issueUpdate.success) throw new Error("linear_label_writeback_failed")
}
