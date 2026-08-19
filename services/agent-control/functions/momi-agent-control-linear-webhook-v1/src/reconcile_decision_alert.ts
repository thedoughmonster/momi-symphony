import { getDatabase } from "../../../src/database.ts"
import {
  decisionIdentity, decisionRecordMatchesLabel, selectLinearDecision,
} from "../../../src/decision_record.ts"
import { linearGraphql } from "../../momi-agent-control-dispatch-v1/src/linear_graphql.ts"

type DecisionIssue = {
  id: string
  identifier: string
  title: string
  url: string
  project_id: string
  labels: string[]
  comments: Array<{ id: string; body: string }>
}

type DeliveryWake = {
  disposition: string
  work_id: string | null
  capability_token: string | null
}

export async function reconcileDecisionAlert(
  issueId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ disposition: string }> {
  const issue = await loadDecisionIssue(issueId)
  const selected = selectLinearDecision(issue.comments)
  if (!selected.decision) return { disposition: selected.reason }
  if (!selected.decision.affected_issue_identifiers.includes(issue.identifier)) {
    return { disposition: "decision_affected_issue_missing" }
  }
  const labelState = decisionRecordMatchesLabel(selected.decision, issue.labels)
  if (!labelState.eligible) return { disposition: labelState.reason }
  const wake = await persistReconciliation(issue, selected.decision,
    decisionIdentity(issue.id, selected.decision))
  if (!wake.work_id || !wake.capability_token) return { disposition: wake.disposition }
  const baseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? ""
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(baseUrl)) {
    throw new Error("decision_delivery_url_unavailable")
  }
  const response = await fetchImpl(`${baseUrl}/functions/v1/momi-decision-alert-delivery-v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ work_id: wake.work_id, capability_token: wake.capability_token }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error("decision_delivery_adapter_unavailable")
  return { disposition: wake.disposition }
}

async function loadDecisionIssue(issueId: string): Promise<DecisionIssue> {
  const data = await linearGraphql<{ issue?: unknown }>(`query AgentControlDecision($id: String!) {
    issue(id: $id) {
      id identifier title url
      project { id }
      labels(first: 250) { nodes { name } pageInfo { hasNextPage } }
      comments(first: 250) { nodes { id body } pageInfo { hasNextPage } }
    }
  }`, { id: issueId })
  const raw = record(data.issue)
  const project = record(raw?.project)
  const labels = connection(raw?.labels, "linear_decision_labels_malformed")
  const comments = connection(raw?.comments, "linear_decision_comments_malformed")
  const issue = {
    id: required(raw?.id, "linear_decision_issue_id_missing"),
    identifier: required(raw?.identifier, "linear_decision_identifier_missing"),
    title: required(raw?.title, "linear_decision_title_missing"),
    url: required(raw?.url, "linear_decision_url_missing"),
    project_id: required(project?.id, "linear_decision_project_missing"),
    labels: labels.map((node) => required(node.name, "linear_decision_label_malformed")),
    comments: comments.map((node) => ({
      id: required(node.id, "linear_decision_comment_id_malformed"),
      body: typeof node.body === "string" ? node.body
        : raise("linear_decision_comment_body_malformed"),
    })),
  }
  if (!/^https:\/\/linear\.app\//.test(issue.url)) throw new Error("linear_decision_url_invalid")
  return issue
}

async function persistReconciliation(
  issue: DecisionIssue,
  decision: NonNullable<ReturnType<typeof selectLinearDecision>["decision"]>,
  identity: string,
): Promise<DeliveryWake> {
  const sql = getDatabase()
  const rows = await sql<DeliveryWake[]>`
    select disposition, work_id::text, capability_token::text
    from momi_agent_ops.reconcile_decision_alert_v1(
      ${issue.project_id}::uuid, ${issue.id}::uuid, ${issue.identifier},
      ${issue.title}, ${issue.url}, ${decision.comment_id}::uuid,
      ${decision.decision_key}, ${identity}, ${decision.category},
      ${decision.status}, ${decision.question}, ${decision.policy_gap},
      ${decision.recommendation}, ${decision.alternatives}::text[],
      ${decision.consequences}::text[],
      ${decision.affected_issue_identifiers}::text[], ${decision.resolution_summary}
    )
  `
  if (!rows[0]) throw new Error("decision_reconciliation_failed")
  return rows[0]
}

function connection(value: unknown, code: string): Record<string, unknown>[] {
  const decoded = record(value)
  const pageInfo = record(decoded?.pageInfo)
  if (!decoded || !Array.isArray(decoded.nodes) || pageInfo?.hasNextPage !== false) {
    throw new Error(code)
  }
  return decoded.nodes.map((node) => record(node) ?? raise(code))
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function required(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code)
  return value.trim()
}

function raise(code: string): never {
  throw new Error(code)
}
