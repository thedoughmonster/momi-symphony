import type { ClaimedDecisionDelivery, SlackDeliveryOutcome } from "./types.ts"

type SlackResponse = { ok?: unknown; channel?: unknown; ts?: unknown; error?: unknown }

export function buildSlackText(work: ClaimedDecisionDelivery): string {
  const text = work.delivery_kind === "resolution"
    ? [
      "Decision resolved in Linear",
      `${work.issue_identifier}: ${work.issue_title}`,
      `Decision: ${work.decision_identity}`,
      `Resolution: ${work.resolution_summary}`,
      work.issue_url,
    ].join("\n")
    : [
      "Material decision needed",
      `${work.issue_identifier}: ${work.issue_title}`,
      work.issue_url,
      `Question: ${work.question}`,
      `Why policy is insufficient: ${work.policy_gap}`,
      `Recommendation: ${work.recommendation}`,
      `Alternatives: ${work.alternatives.join(" | ")}`,
      `Consequences: ${work.consequences.join(" | ")}`,
      `Affected issues: ${work.affected_issue_identifiers.join(", ")}`,
      `Decision: ${work.decision_identity}`,
    ].join("\n")
  if (text.length > 3_800 || /<!(?:channel|here|everyone|subteam)|<@[A-Z0-9]+>/i.test(text)) {
    throw new Error("decision_slack_payload_invalid")
  }
  return text
}

export async function deliverToSlack(
  work: ClaimedDecisionDelivery,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackDeliveryOutcome> {
  if (!token) return failed("slack_secret_unavailable")
  const body: Record<string, unknown> = {
    channel: work.slack_channel_id,
    text: buildSlackText(work),
    mrkdwn: false,
    parse: "none",
    unfurl_links: false,
    unfurl_media: false,
  }
  if (work.delivery_kind === "resolution") {
    if (!work.slack_thread_ts) return failed("slack_thread_receipt_missing")
    body.thread_ts = work.slack_thread_ts
  }
  let response: Response
  try {
    response = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return ambiguous(null, "slack_request_ambiguous")
  }
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"))
  if (response.status === 429) return {
    outcome: "retryable", http_status: 429, retry_after_seconds: retryAfter ?? 30,
    slack_channel_id: null, slack_message_ts: null, error_code: "slack_rate_limited",
  }
  if (response.status >= 500) return ambiguous(response.status, "slack_server_ambiguous")
  const payload = await response.json().catch(() => null) as SlackResponse | null
  if (!payload) return ambiguous(response.status, "slack_response_ambiguous")
  if (payload.ok === true) {
    if (typeof payload.channel !== "string" || payload.channel !== work.slack_channel_id ||
      typeof payload.ts !== "string" || !/^\d{10,}\.[0-9]+$/.test(payload.ts)) {
      return ambiguous(response.status, "slack_receipt_ambiguous")
    }
    return { outcome: "delivered", http_status: response.status,
      retry_after_seconds: null, slack_channel_id: payload.channel,
      slack_message_ts: payload.ts, error_code: null }
  }
  const error = typeof payload.error === "string" && /^[a-z0-9_]{1,80}$/.test(payload.error)
    ? payload.error : "slack_rejected"
  if (error === "ratelimited") return { outcome: "retryable",
    http_status: response.status, retry_after_seconds: retryAfter ?? 30,
    slack_channel_id: null, slack_message_ts: null, error_code: "slack_rate_limited" }
  return failed(error, response.status)
}

function retryAfterSeconds(value: string | null): number | null {
  if (!value || !/^\d{1,4}$/.test(value)) return null
  return Math.min(900, Math.max(1, Number(value)))
}

function ambiguous(status: number | null, code: string): SlackDeliveryOutcome {
  return { outcome: "ambiguous", http_status: status, retry_after_seconds: null,
    slack_channel_id: null, slack_message_ts: null, error_code: code }
}

function failed(code: string, status: number | null = null): SlackDeliveryOutcome {
  return { outcome: "failed", http_status: status, retry_after_seconds: null,
    slack_channel_id: null, slack_message_ts: null, error_code: code }
}
