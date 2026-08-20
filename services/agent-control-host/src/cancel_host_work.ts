import { cancellationFingerprint } from "./cancellation_fingerprint.ts"
import { buildSyntheticTelemetry } from "./attempt_telemetry.ts"
import type { HostLedger } from "./host_ledger.ts"
import type { AppServerClient, HostCancellation, HostCancellationResult,
  HostConfiguration } from "./types.ts"

export async function cancelHostWork(
  client: AppServerClient,
  ledger: HostLedger,
  config: HostConfiguration,
  input: HostCancellation,
): Promise<HostCancellationResult> {
  if (input.repository !== config.repository || input.base_branch !== config.baseBranch) {
    throw new Error("host_mapping_refused")
  }
  const prior = await ledger.reserveCancellation(
    input.work_id, cancellationFingerprint(input), input.target_work_ids)
  if (prior?.state !== undefined && prior.state !== "reserved") {
    return { cancellation_state: prior.state }
  }
  let requested = false
  for (const targetWorkId of input.target_work_ids) {
    const target = ledger.get(targetWorkId)
    if (!target) throw new Error("host_cancel_target_missing")
    if (target.state === "terminal") continue
    requested = true
    if (target.state === "reserved" && !target.threadId && !target.turnId) {
      await ledger.cancellationRequested(target.workId)
      continue
    }
    if (target.state === "interactive") {
      if (!target.threadId) throw new Error("host_cancel_target_ambiguous")
      if (!target.cancellationRequestedAt) {
        await ledger.cancellationRequested(target.workId)
        await client.request("thread/archive", { threadId: target.threadId })
        await ledger.recordTelemetry(target.workId,
          buildSyntheticTelemetry(target, "interrupted"))
        await ledger.terminal(target.workId, { readiness_result: "ready",
          terminal_disposition: "interrupted",
          summary: "Interactive discovery task canceled and archived." },
        new Date().toISOString())
      }
      continue
    }
    if (!target.threadId || !target.turnId) throw new Error("host_cancel_target_ambiguous")
    if (target.cancellationRequestedAt) continue
    await client.request("turn/interrupt", {
      threadId: target.threadId, turnId: target.turnId,
    })
    await ledger.cancellationRequested(target.workId)
  }
  const state = requested ? "requested" : "already_terminal"
  await ledger.completeCancellation(input.work_id, state)
  return { cancellation_state: state }
}
