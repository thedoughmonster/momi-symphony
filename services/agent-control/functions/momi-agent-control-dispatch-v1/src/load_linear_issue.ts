import { linearGraphql } from "./linear_graphql.ts"
import { createLinearAdapterProfile, normalizeLinearIssue } from "./linear_issue_adapter.ts"
import type { LinearAdapterProfile } from "./linear_issue_adapter.ts"
import type { LinearIssueState } from "./types.ts"

export async function loadLinearIssue(
  issueId: string,
  profile: LinearAdapterProfile = createLinearAdapterProfile(),
): Promise<LinearIssueState> {
  const data = await linearGraphql<{ issue: unknown | null }>(`query AgentControlIssue($id: String!) {
    issue(id: $id) {
      id identifier title description priority branchName url createdAt updatedAt
      state { id name type }
      assignee { id }
      project { id }
      team { id labels(first: 250) { nodes { id name } } }
      labels(first: 250) {
        nodes { id name }
        pageInfo { hasNextPage endCursor }
      }
      parent { id identifier state { id name type } }
      children(first: 50) {
        nodes { id identifier state { id name type } }
        pageInfo { hasNextPage endCursor }
      }
      inverseRelations(first: 50) {
        nodes { type issue { id identifier state { id name type } } }
        pageInfo { hasNextPage endCursor }
      }
      comments(first: 250) { nodes { id body } }
    }
  }`, { id: issueId })
  if (!data.issue) throw new Error("linear_issue_not_found")
  const issue = record(data.issue)
  if (!issue) throw new Error("linear_issue_payload_malformed")
  const normalized = normalizeLinearIssue(issue, profile)
  const team = record(issue.team)
  return { ...normalized,
    labelRefs: labelNodes(issue.labels, "linear_issue_labels_malformed"),
    teamLabels: labelNodes(record(team?.labels), "linear_team_labels_malformed"),
    comments: commentNodes(issue.comments) }
}

function labelNodes(value: unknown, code: string): Array<{ id: string; name: string }> {
  const connection = record(value)
  if (!connection || !Array.isArray(connection.nodes)) throw new Error(code)
  return connection.nodes.map((node) => {
    const label = record(node)
    if (!text(label?.id) || !text(label?.name)) throw new Error(code)
    return { id: text(label?.id)!, name: text(label?.name)! }
  })
}

function commentNodes(value: unknown): Array<{ id: string; body: string }> {
  const connection = record(value)
  if (!connection || !Array.isArray(connection.nodes)) {
    throw new Error("linear_issue_comments_malformed")
  }
  return connection.nodes.map((node) => {
    const comment = record(node)
    if (!text(comment?.id) || typeof comment?.body !== "string") {
      throw new Error("linear_issue_comments_malformed")
    }
    return { id: text(comment.id)!, body: comment.body }
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
