import { dispatchFingerprint } from "./dispatch_fingerprint.ts"
import { cancelHostWork } from "./cancel_host_work.ts"
import { extractTerminalSummary } from "./extract_terminal_summary.ts"
import { finishInteractiveArchive } from "./finish_interactive_archive.ts"
import { HostLedger } from "./host_ledger.ts"
import { parseTerminalNotification } from "./parse_terminal_notification.ts"
import { parseThreadArchived } from "./parse_thread_archived.ts"
import { sendTerminalCallback } from "./send_terminal_callback.ts"
import { startHostTask } from "./start_host_task.ts"
import type { AppServerClient, HostAcceptance, HostConfiguration,
  HostCancellation, HostCancellationResult, HostDispatch, HostRecord, TurnShape } from "./types.ts"
export class HostController {
  private finalizing = new Set<string>()
  private callbackTimers = new Set<string>()
  private notifications: Promise<void> = Promise.resolve()
  private readonly client: AppServerClient
  private readonly ledger: HostLedger
  private readonly config: HostConfiguration
  private readonly callback: (record: HostRecord) => Promise<void>

  constructor(client: AppServerClient, ledger: HostLedger, config: HostConfiguration,
    callback: (record: HostRecord) => Promise<void> = sendTerminalCallback) {
    this.client = client; this.ledger = ledger; this.config = config; this.callback = callback
  }
  async start(): Promise<void> {
    await this.ledger.load(); await this.client.connect()
    this.client.onNotification((notification) => {
      this.notifications = this.notifications.then(
        () => this.handleNotification(notification)).catch(() => undefined)
    })
    for (const record of this.ledger.recoverable()) {
      try {
        if (record.state === "terminal") await this.deliverCallback(record)
        else {
          const accepted = record.state === "ambiguous"
            ? await this.ledger.accept(record.workId, record.threadId!, record.turnId!) : record
          await this.recover(accepted)
        }
      } catch {
        // Durable records remain recoverable after a transient startup failure.
      }
    }
  }

  async dispatch(input: HostDispatch): Promise<HostAcceptance> {
    if (input.repository !== this.config.repository ||
      input.base_branch !== this.config.baseBranch) throw new Error("host_mapping_refused")
    const prior = this.ledger.get(input.work_id)
    const record = await this.ledger.reserve(input.work_id,
      dispatchFingerprint(input), input.capability_token, input.interaction_mode)
    if (prior) {
      if (record.threadId && record.turnId) {
        const resumed = record.state === "ambiguous"
          ? await this.ledger.accept(input.work_id, record.threadId, record.turnId) : record
        if (resumed.state === "terminal" && !resumed.callbackSent) {
          this.scheduleCallback(resumed)
        } else if (resumed.state === "accepted") {
          void this.recover(resumed).catch(() => undefined)
        }
        return { thread_id: record.threadId, turn_id: record.turnId }
      }
      throw new Error(record.state === "ambiguous"
        ? "host_start_ambiguous" : "host_dispatch_in_progress")
    }
    try {
      const started = await startHostTask(this.client, this.config, input)
      const accepted = await this.ledger.accept(
        input.work_id, started.thread_id, started.turn_id)
      void this.recover(accepted).catch(() => undefined)
      return started
    } catch (error) {
      await this.ledger.ambiguous(input.work_id); throw error
    }
  }
  async cancel(input: HostCancellation): Promise<HostCancellationResult> {
    const result = await cancelHostWork(this.client, this.ledger, this.config, input)
    const target = this.ledger.get(input.target_work_id)
    if (target?.state === "terminal" && !target.callbackSent) {
      await this.deliverCallback(target)
    }
    return result
  }

  private async handleNotification(notification: Record<string, unknown>): Promise<void> {
    const archivedThread = parseThreadArchived(notification)
    if (archivedThread) {
      const record = this.ledger.findByThread(archivedThread)
      if (record?.state === "interactive" && !record.cancellationRequestedAt) {
        await finishInteractiveArchive(this.ledger, record, this.callback)
      }
      return
    }
    const terminal = parseTerminalNotification(notification)
    if (!terminal) return
    const record = this.ledger.recoverable().find((candidate) =>
      candidate.threadId === terminal.threadId && candidate.turnId === terminal.turn.id)
    if (record) await this.finalize(record, terminal.turn)
  }

  private async recover(record: HostRecord): Promise<void> {
    if (!record.threadId || !record.turnId) return
    const response = await this.client.request<{ thread: { turns: TurnShape[] } }>(
      "thread/resume", { threadId: record.threadId },
    )
    const turn = response.thread.turns.find((candidate) => candidate.id === record.turnId)
    if (turn && turn.status !== "inProgress") await this.finalize(record, turn)
  }

  private async finalize(record: HostRecord, turn: TurnShape): Promise<void> {
    if (!record.threadId || this.finalizing.has(record.workId)) return
    this.finalizing.add(record.workId)
    try {
      if (record.interactionMode === "interactive" && turn.status === "completed" &&
        !record.cancellationRequestedAt) {
        await this.ledger.retainInteractive(record.workId); return
      }
      await this.client.request("thread/archive", { threadId: record.threadId })
      const archivedAt = new Date().toISOString()
      const terminal = await this.ledger.terminal(
        record.workId, extractTerminalSummary(turn), archivedAt)
      await this.deliverCallback(terminal)
    } finally {
      this.finalizing.delete(record.workId)
    }
  }

  private async deliverCallback(record: HostRecord): Promise<void> {
    await this.callback(record); await this.ledger.callbackSent(record.workId)
  }

  private scheduleCallback(record: HostRecord): void {
    if (this.callbackTimers.has(record.workId)) return
    this.callbackTimers.add(record.workId)
    setTimeout(() => {
      this.callbackTimers.delete(record.workId)
      void this.deliverCallback(record).catch(() => undefined)
    }, 1000)
  }
}
