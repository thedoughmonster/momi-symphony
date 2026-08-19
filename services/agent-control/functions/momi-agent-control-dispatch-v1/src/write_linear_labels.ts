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

export async function writeLinearCompletion(
  issueId: string,
  labelIds: string[],
  stateId: string,
): Promise<void> {
  const data = await linearGraphql<{ issueUpdate: { success: boolean;
    issue: { state: { id: string; type: string } | null } | null } }>(
      `mutation AgentControlCompletion(
        $id: String!, $labelIds: [String!]!, $stateId: String!
      ) {
        issueUpdate(id: $id, input: { labelIds: $labelIds, stateId: $stateId }) {
          success
          issue { state { id type } }
        }
      }`,
      { id: issueId, labelIds, stateId },
    )
  if (!data.issueUpdate.success || data.issueUpdate.issue?.state?.id !== stateId ||
    data.issueUpdate.issue.state.type !== "completed") {
    throw new Error("linear_completion_writeback_failed")
  }
}
