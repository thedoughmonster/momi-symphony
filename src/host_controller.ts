import { dispatchFingerprint } from "./dispatch_fingerprint.ts"
import { extractTerminalSummary } from "./extract_terminal_summary.ts"
import { HostLedger } from "./host_ledger.ts"
import { parseTerminalNotification } from "./parse_terminal_notification.ts"
import { sendTerminalCallback } from "./send_terminal_callback.ts"
import type { AppServerClient, HostAcceptance, HostConfiguration,
  HostDispatch, HostRecord, TurnShape } from "./types.ts"

export class HostController {
  private finalizing = new Set<string>()
  private callbackTimers = new Set<string>()
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
      void this.handleNotification(notification).catch(() => undefined)
    })
    for (const record of this.ledger.recoverable()) {
      try {
        if (record.state === "terminal") await this.deliverCallback(record)
        else await this.recover(record)
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
      dispatchFingerprint(input), input.capability_token)
    if (prior) {
      if (record.threadId && record.turnId) {
        if (record.state === "terminal" && !record.callbackSent) this.scheduleCallback(record)
        return { thread_id: record.threadId, turn_id: record.turnId }
      }
      throw new Error(record.state === "ambiguous"
        ? "host_start_ambiguous" : "host_dispatch_in_progress")
    }
    try {
      const started = await this.client.request<{ thread: { id: string } }>("thread/start", {
        cwd: this.config.workspaceRoot,
        serviceName: "momi-agent-control", threadSource: "momi_agent_control",
      })
      const turn = await this.client.request<{ turn: { id: string } }>("turn/start", {
        threadId: started.thread.id, clientUserMessageId: input.work_id,
        approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
        input: [{ type: "text", text: input.instruction, text_elements: [] }],
        responsesapiClientMetadata: { work_id: input.work_id,
          issue_identifier: input.issue_identifier },
        outputSchema: { type: "object", additionalProperties: false,
          required: ["readiness_result", "disposition", "summary"], properties: {
            readiness_result: { enum: ["ready", "unready", "failed"] },
            disposition: { enum: ["completed", "failed", "interrupted"] },
            summary: { type: "string", maxLength: 1000 } } },
      })
      const accepted = await this.ledger.accept(input.work_id, started.thread.id, turn.turn.id)
      await this.recover(accepted)
      return { thread_id: started.thread.id, turn_id: turn.turn.id }
    } catch (error) {
      await this.ledger.ambiguous(input.work_id); throw error
    }
  }

  private async handleNotification(notification: Record<string, unknown>): Promise<void> {
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
