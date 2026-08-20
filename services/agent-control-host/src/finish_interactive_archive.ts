import type { HostLedger } from "./host_ledger.ts"
import { buildSyntheticTelemetry } from "./attempt_telemetry.ts"
import type { HostRecord } from "./types.ts"

export async function finishInteractiveArchive(
  ledger: HostLedger,
  record: HostRecord,
  callback: (record: HostRecord) => Promise<void>,
): Promise<void> {
  await ledger.recordTelemetry(record.workId, buildSyntheticTelemetry(record, "completed"))
  const terminal = await ledger.terminal(record.workId, {
    readiness_result: "ready", terminal_disposition: "completed",
    summary: "Interactive discovery task archived.",
  }, new Date().toISOString())
  await callback(terminal)
  await ledger.callbackSent(record.workId)
}
