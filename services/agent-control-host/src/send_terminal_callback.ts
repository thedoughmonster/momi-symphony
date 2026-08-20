import type { HostRecord } from "./types.ts"

export async function sendTerminalCallback(
  record: HostRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!record.threadId || !record.turnId || !record.terminal || !record.telemetry) {
    throw new Error("terminal_callback_record_incomplete")
  }
  const configured = process.env.MOMI_AGENT_CONTROL_CALLBACK_URL?.trim() ?? ""
  const secret = process.env.MOMI_CODEX_HOST_SECRET?.trim() ?? ""
  const url = new URL(configured)
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)
  if ((!loopback && url.protocol !== "https:") || !secret) {
    throw new Error("terminal_callback_configuration_refused")
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchImpl(url, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ event: "terminal", work_id: record.workId,
        capability_token: record.capabilityToken, thread_id: record.threadId,
        turn_id: record.turnId, readiness_result: record.terminal.readiness_result,
        terminal_disposition: record.terminal.terminal_disposition,
        archived_at: record.terminal.archivedAt, summary: record.terminal.summary,
        telemetry: record.telemetry }),
      signal: AbortSignal.timeout(10_000) })
    if (response.ok) return
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
  }
  throw new Error("terminal_callback_failed")
}
