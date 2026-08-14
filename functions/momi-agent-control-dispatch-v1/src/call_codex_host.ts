import { buildCodexInstruction } from "./build_codex_instruction.ts"
import type { ClaimedDispatch, HostAcceptance } from "./types.ts"

export async function callCodexHost(
  work: ClaimedDispatch,
  capabilityToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostAcceptance> {
  const configured = Deno.env.get("MOMI_CODEX_HOST_ADAPTER_URL")?.trim() ?? ""
  const secret = Deno.env.get("MOMI_CODEX_HOST_SECRET")?.trim() ?? ""
  const url = new URL(configured)
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)
  if ((!loopback && url.protocol !== "https:") || !secret) {
    throw new Error("codex_host_configuration_refused")
  }
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ schema_version: 1, work_id: work.work_id,
      capability_token: capabilityToken, issue_id: work.issue_id,
      issue_identifier: work.issue_identifier, issue_url: work.issue_url,
      project_id: work.project_id, project_name: work.project_name,
      repository: work.repository, base_branch: work.base_branch,
      active_states: work.active_states, instruction: buildCodexInstruction(work) }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || typeof body?.thread_id !== "string" ||
    typeof body.turn_id !== "string") throw new Error("codex_host_delivery_failed")
  return { thread_id: body.thread_id, turn_id: body.turn_id }
}
