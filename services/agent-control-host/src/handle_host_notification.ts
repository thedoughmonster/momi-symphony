import { finishInteractiveArchive } from "./finish_interactive_archive.ts"
import type { HostLedger } from "./host_ledger.ts"
import { parseTerminalNotification } from "./parse_terminal_notification.ts"
import { parseThreadArchived } from "./parse_thread_archived.ts"
import type { HostRecord, TurnShape } from "./types.ts"

export async function handleHostNotification(
  notification: Record<string, unknown>,
  ledger: HostLedger,
  callback: (record: HostRecord) => Promise<void>,
  finalize: (record: HostRecord, turn: TurnShape) => Promise<void>,
  runtimeRole?: "implementation" | "independent_reviewer",
): Promise<void> {
  const archivedThread = parseThreadArchived(notification)
  if (archivedThread) {
    const record = ledger.findByThread(archivedThread, runtimeRole)
    if (record?.state === "interactive" && !record.cancellationRequestedAt &&
      !record.recoveryRequestedAt) {
      await finishInteractiveArchive(ledger, record, callback)
    }
    return
  }
  const terminal = parseTerminalNotification(notification)
  if (!terminal) return
  const record = ledger.recoverable().find((candidate) =>
    candidate.threadId === terminal.threadId && candidate.turnId === terminal.turn.id &&
    (!runtimeRole || (candidate.runtimeRole ?? "implementation") === runtimeRole))
  if (record) await finalize(record, terminal.turn)
}
