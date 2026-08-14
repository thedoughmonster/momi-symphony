import { callCodexHost } from "./call_codex_host.ts"
import { claimDispatch } from "./claim_dispatch.ts"
import { isHostAuthorized } from "./is_host_authorized.ts"
import { parseDispatchInput } from "./parse_dispatch_input.ts"
import { processDispatch } from "./process_dispatch.ts"
import { processTerminal } from "./process_terminal.ts"
import { reconcileLinear } from "./reconcile_linear.ts"
import { reconcileTerminal } from "./reconcile_terminal.ts"
import { readLinearAccessToken } from "./read_linear_access_token.ts"
import { recordHostAcceptance } from "./record_host_acceptance.ts"
import { recordLinearWriteback } from "./record_linear_writeback.ts"
import { recordTerminal } from "./record_terminal.ts"
import { retryDispatch } from "./retry_dispatch.ts"
import type { DispatchDependencies, TerminalInput } from "./types.ts"

export async function handleRequestWithDependencies(
  request: Request,
  injected?: { dispatch: DispatchDependencies; recordTerminal: typeof recordTerminal;
    reconcileTerminal: typeof reconcileTerminal;
    terminalWriteback: (terminal: TerminalInput, commentId: string) => Promise<boolean>;
    hostSecret: string },
): Promise<Response> {
  if (request.method === "GET") {
    const ready = Boolean(Deno.env.get("MOMI_CODEX_HOST_SECRET")?.trim() &&
      readLinearAccessToken())
    return Response.json({ ok: ready, function_key: "momi.agent_control.dispatch.v1" })
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  const input = parseDispatchInput(await request.json().catch(() => null))
  if (!input) return new Response("invalid request", { status: 400 })
  try {
    if ("event" in input) {
      const secret = injected?.hostSecret ?? Deno.env.get("MOMI_CODEX_HOST_SECRET")?.trim() ?? ""
      if (!await isHostAuthorized(request.headers.get("authorization"), secret)) {
        return new Response("unauthorized", { status: 401 })
      }
      const result = await processTerminal(input as TerminalInput,
        injected?.recordTerminal ?? recordTerminal,
        injected?.reconcileTerminal ?? reconcileTerminal,
        injected?.terminalWriteback ?? ((terminal, commentId) =>
          recordLinearWriteback(terminal, commentId, true)))
      return Response.json(result)
    }
    const dependencies = injected?.dispatch ?? { claim: claimDispatch,
      callHost: callCodexHost, hostAccepted: recordHostAcceptance,
      reconcile: reconcileLinear, writeback: recordLinearWriteback,
      retry: retryDispatch }
    return Response.json(await processDispatch(input, dependencies))
  } catch (error) {
    console.error("Agent control delivery failed", input.work_id,
      error instanceof Error ? error.message : "unknown")
    return Response.json({ ok: false, disposition: "retrying" }, { status: 503 })
  }
}
