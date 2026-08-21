import { cancellationFingerprint } from "./cancellation_fingerprint.ts"
import { buildSyntheticTelemetry } from "./attempt_telemetry.ts"
import type { HostLedger } from "./host_ledger.ts"
import type { AppServerClient, HostCancellation, HostCancellationResult,
  HostConfiguration, HostRecord } from "./types.ts"

export type HostClientResolver = AppServerClient | ((record: HostRecord) => AppServerClient)

export async function cancelHostWork(
  client: HostClientResolver,
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
    let target = ledger.get(targetWorkId)
    if (!target) {
      requested = true
      continue
    }
    if (target.state === "terminal") continue
    requested = true
    const targetClient = typeof client === "function" ? client(target) : client
    if (target.runtimeRole === "independent_reviewer" && target.state !== "interactive") {
      const fenced = await ledger.fenceCanceledStart(target.workId)
      await interruptClaimed(targetClient, ledger, fenced.record, fenced.interruptionClaimed)
      continue
    }
    if (target.state === "reserved" && !target.threadId && !target.turnId) {
      await ledger.fenceCanceledStart(target.workId)
      continue
    }
    if (target.state === "ambiguous" && (!target.threadId || !target.turnId)) {
      await ledger.fenceCanceledStart(target.workId)
      continue
    }
    if (target.state === "interactive") {
      if (!target.threadId) continue
      if (!target.cancellationRequestedAt) {
        await ledger.cancellationRequested(target.workId)
        try {
          await targetClient.request("thread/archive", { threadId: target.threadId })
          await ledger.recordTelemetry(target.workId,
            buildSyntheticTelemetry(target, "interrupted"))
          await ledger.terminal(target.workId, { readiness_result: "ready",
            terminal_disposition: "interrupted",
            summary: "Interactive discovery task canceled and archived." },
          new Date().toISOString())
        } catch { /* Durable database cancellation remains authoritative. */ }
      }
      continue
    }
    if (!target.threadId || !target.turnId) {
      await ledger.fenceCanceledStart(target.workId)
      continue
    }
    if (target.cancellationRequestedAt) continue
    const fenced = await ledger.fenceCanceledStart(target.workId)
    await interruptClaimed(targetClient, ledger, fenced.record, fenced.interruptionClaimed)
  }
  const state = requested ? "requested" : "already_terminal"
  await ledger.completeCancellation(input.work_id, state)
  return { cancellation_state: state }
}

async function interruptClaimed(client: AppServerClient, ledger: HostLedger,
  record: HostRecord, claimed: boolean): Promise<void> {
  if (!claimed || !record.threadId || !record.turnId) return
  try {
    await client.request("turn/interrupt", {
      threadId: record.threadId, turnId: record.turnId,
    })
    await ledger.interruptionConfirmed(record.workId)
  } catch (error) {
    await ledger.interruptionFailed(record.workId)
  }
}
