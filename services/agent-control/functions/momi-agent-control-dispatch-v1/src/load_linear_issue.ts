import { linearGraphql } from "./linear_graphql.ts"
import type { LinearIssueState } from "./types.ts"

export async function loadLinearIssue(issueId: string): Promise<LinearIssueState> {
  const data = await linearGraphql<{ issue: {
    id: string; identifier: string; state: { name: string }
    labels: { nodes: Array<{ id: string; name: string }> }
    team: { labels: { nodes: Array<{ id: string; name: string }> } }
    comments: { nodes: Array<{ id: string; body: string }> }
  } | null }>(`query AgentControlIssue($id: String!) {
    issue(id: $id) { id identifier state { name }
      labels { nodes { id name } }
      team { labels(first: 250) { nodes { id name } } }
      comments(first: 250) { nodes { id body } }
    }
  }`, { id: issueId })
  if (!data.issue) throw new Error("linear_issue_not_found")
  return { id: data.issue.id, identifier: data.issue.identifier,
    state: data.issue.state.name, labels: data.issue.labels.nodes,
    teamLabels: data.issue.team.labels.nodes, comments: data.issue.comments.nodes }
}
