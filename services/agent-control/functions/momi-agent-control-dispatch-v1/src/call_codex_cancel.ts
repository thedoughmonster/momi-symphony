import type { ClaimedDispatch, HostCancellation } from "./types.ts"
import { parseReviewCancellationReceipts } from "./review_cancellation_receipt.ts"

export async function callCodexCancel(
  work: ClaimedDispatch,
  capabilityToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostCancellation> {
  const configured = work.host_dispatch_url?.trim() ?? ""
  const secret = Deno.env.get("MOMI_CODEX_HOST_SECRET")?.trim() ?? ""
  let url: URL
  try { url = new URL(configured) } catch { throw new Error("codex_host_url_unconfigured") }
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)
  if ((!loopback && url.protocol !== "https:") || !secret ||
    !url.pathname.endsWith("/v1/dispatch") || work.cancellation_target_ids.length === 0) {
    throw new Error("codex_host_configuration_refused")
  }
  url.pathname = `${url.pathname.slice(0, -"/v1/dispatch".length)}/v1/cancel`
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ schema_version: 2, work_id: work.work_id,
      capability_token: capabilityToken, target_work_ids: work.cancellation_target_ids,
      repository: work.repository, base_branch: work.base_branch }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  const state = body?.cancellation_state
  const receipts = parseReviewCancellationReceipts(body?.review_cancellations,
    work.cancellation_target_ids)
  if (!response.ok || !["requested", "already_terminal"].includes(String(state))) {
    throw new Error("codex_host_cancellation_failed")
  }
  if (!receipts) throw new Error("codex_host_cancellation_receipt_invalid")
  return { cancellation_state: state as HostCancellation["cancellation_state"],
    review_cancellations: receipts }
}
