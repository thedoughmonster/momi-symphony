import { cancellationFingerprint } from "./cancellation_fingerprint.ts"
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
    input.work_id, cancellationFingerprint(input), input.target_work_id)
  if (prior?.state !== undefined && prior.state !== "reserved") {
    return { cancellation_state: prior.state }
  }
  const target = ledger.get(input.target_work_id)
  if (!target) throw new Error("host_cancel_target_missing")
  if (target.state === "terminal") {
    await ledger.completeCancellation(input.work_id, "already_terminal")
    return { cancellation_state: "already_terminal" }
  }
  if (target.state === "interactive") {
    if (!target.threadId) throw new Error("host_cancel_target_ambiguous")
    await ledger.cancellationRequested(target.workId)
    await client.request("thread/archive", { threadId: target.threadId })
    await ledger.terminal(target.workId, { readiness_result: "ready",
      terminal_disposition: "interrupted",
      summary: "Interactive discovery task canceled and archived." },
    new Date().toISOString())
    await ledger.completeCancellation(input.work_id, "requested")
    return { cancellation_state: "requested" }
  }
  if (!target.threadId || !target.turnId) throw new Error("host_cancel_target_ambiguous")
  if (target.cancellationRequestedAt) {
    await ledger.completeCancellation(input.work_id, "requested")
    return { cancellation_state: "requested" }
  }
  await client.request("turn/interrupt", {
    threadId: target.threadId, turnId: target.turnId,
  })
  await ledger.cancellationRequested(target.workId)
  await ledger.completeCancellation(input.work_id, "requested")
  return { cancellation_state: "requested" }
}
