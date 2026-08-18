import type { ClaimedDispatch, HostCancellation } from "./types.ts"

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
    !url.pathname.endsWith("/v1/dispatch") || !work.target_dispatch_id) {
    throw new Error("codex_host_configuration_refused")
  }
  url.pathname = `${url.pathname.slice(0, -"/v1/dispatch".length)}/v1/cancel`
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ schema_version: 1, work_id: work.work_id,
      capability_token: capabilityToken, target_work_id: work.target_dispatch_id,
      repository: work.repository, base_branch: work.base_branch }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  const state = body?.cancellation_state
  if (!response.ok || !["requested", "already_terminal"].includes(String(state))) {
    throw new Error("codex_host_cancellation_failed")
  }
  return { cancellation_state: state as HostCancellation["cancellation_state"] }
}
