import type { HostLedger } from "./host_ledger.ts"
import type { HostRecord } from "./types.ts"

export async function finishInteractiveArchive(
  ledger: HostLedger,
  record: HostRecord,
  callback: (record: HostRecord) => Promise<void>,
): Promise<void> {
  const terminal = await ledger.terminal(record.workId, {
    readiness_result: "ready", terminal_disposition: "completed",
    summary: "Interactive discovery task archived.",
  }, new Date().toISOString())
  await callback(terminal)
  await ledger.callbackSent(record.workId)
}
