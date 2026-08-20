import { callCodexHost } from "./call_codex_host.ts"
import { callCodexCancel } from "./call_codex_cancel.ts"
import { callCodexRecovery } from "./call_codex_recovery.ts"
import { claimDispatch } from "./claim_dispatch.ts"
import { isHostAuthorized } from "./is_host_authorized.ts"
import { parseDispatchInput } from "./parse_dispatch_input.ts"
import { processDispatch } from "./process_dispatch.ts"
import { processTerminal } from "./process_terminal.ts"
import { processLifecycleEvidence } from "./process_lifecycle_evidence.ts"
import { reconcileLinear } from "./reconcile_linear.ts"
import { reconcileTerminal } from "./reconcile_terminal.ts"
import { readLinearAccessToken } from "./read_linear_access_token.ts"
import { processReadyLeafSchedulerPump } from "./ready_leaf_scheduler.ts"
import { recordHostAcceptance } from "./record_host_acceptance.ts"
import { recordCancellation } from "./record_cancellation.ts"
import { recordRecovery } from "./record_recovery.ts"
import { recordLinearWriteback } from "./record_linear_writeback.ts"
import { recordTerminal } from "./record_terminal.ts"
import { retryDispatch } from "./retry_dispatch.ts"
import { reconcileAgentState } from "./agent_state_projection.ts"
import type { DispatchDependencies, TerminalInput } from "./types.ts"

export async function handleRequestWithDependencies(
  request: Request,
  injected?: { dispatch: DispatchDependencies; recordTerminal: typeof recordTerminal;
    reconcileTerminal: typeof reconcileTerminal;
    terminalWriteback: (terminal: TerminalInput, commentId: string) => Promise<boolean>;
    schedulerPump: typeof processReadyLeafSchedulerPump;
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
      if (input.event === "scheduler_pump") {
        const result = await (injected?.schedulerPump ?? processReadyLeafSchedulerPump)(input)
        return Response.json(result)
      }
      if (input.event === "lifecycle_evidence") {
        return Response.json(await processLifecycleEvidence(input))
      }
      const result = await processTerminal(input as TerminalInput,
        injected?.recordTerminal ?? recordTerminal,
        injected?.reconcileTerminal ?? reconcileTerminal,
        injected?.terminalWriteback ?? ((terminal, commentId) =>
          recordLinearWriteback(terminal, commentId, true)),
        reconcileAgentState)
      return Response.json(result)
    }
    const dependencies = injected?.dispatch ?? { claim: claimDispatch,
      callHost: callCodexHost, callCancel: callCodexCancel,
      callRecovery: callCodexRecovery,
      hostAccepted: recordHostAcceptance, cancellationRecorded: recordCancellation,
      recoveryRecorded: recordRecovery,
      reconcile: reconcileLinear, writeback: recordLinearWriteback,
      retry: retryDispatch, project: reconcileAgentState }
    return Response.json(await processDispatch(input, dependencies))
  } catch (error) {
    const requestId = "work_id" in input ? input.work_id : input.scheduler_id
    console.error("Agent control delivery failed", requestId,
      error instanceof Error ? error.message : "unknown")
    return Response.json({ ok: false, disposition: "retrying" }, { status: 503 })
  }
}
