import { budgetForAction, EXECUTION_POLICY_VERSION } from "../../../src/execution_efficiency.ts"
import { buildCodexPrompt } from "./build_codex_instruction.ts"
import type { ClaimedDispatch, HostAcceptance } from "./types.ts"

export async function callCodexHost(
  work: ClaimedDispatch,
  capabilityToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostAcceptance> {
  if (work.action === "recover-discovery") {
    throw new Error("codex_host_recovery_requires_recovery_endpoint")
  }
  const configured = work.host_dispatch_url?.trim() ?? ""
  const secret = Deno.env.get("MOMI_CODEX_HOST_SECRET")?.trim() ?? ""
  let url: URL
  try { url = new URL(configured) } catch {
    throw new Error("codex_host_url_unconfigured")
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)
  if ((!loopback && url.protocol !== "https:") || !secret) {
    throw new Error("codex_host_configuration_refused")
  }
  const prompt = buildCodexPrompt(work)
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ schema_version: 3, work_id: work.work_id,
      capability_token: capabilityToken, issue_id: work.issue_id,
      issue_identifier: work.issue_identifier, issue_url: work.issue_url,
      project_id: work.project_id, project_name: work.project_name,
      repository: work.repository, base_branch: work.base_branch,
      active_states: work.active_states,
      interaction_mode: work.action === "run-discovery" ? "interactive" : "one_shot",
      thread_name: work.action === "run-discovery"
        ? `${work.issue_identifier} · interactive discovery`
        : `${work.issue_identifier} · ${work.action}`,
      stable_instruction: prompt.stablePrefix,
      volatile_context: prompt.volatileContext,
      stable_prefix_fingerprint: prompt.stablePrefixFingerprint,
      context_fingerprint: prompt.contextFingerprint,
      policy_version: EXECUTION_POLICY_VERSION,
      budget: budgetForAction(work.action) }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || typeof body?.thread_id !== "string" ||
    typeof body.turn_id !== "string") throw new Error("codex_host_delivery_failed")
  return { thread_id: body.thread_id, turn_id: body.turn_id }
}
