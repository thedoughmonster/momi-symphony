import { dispatchFingerprint } from "./dispatch_fingerprint.ts"
import { budgetDisposition, buildAttemptTelemetry } from "./attempt_telemetry.ts"
import { cancelHostWork } from "./cancel_host_work.ts"
import { cleanupReviewWorkspace } from "./cleanup_review_workspace.ts"
import { extractTerminalSummary } from "./extract_terminal_summary.ts"
import { extractReviewResult } from "./extract_review_result.ts"
import { handleHostNotification } from "./handle_host_notification.ts"
import { HostLedger } from "./host_ledger.ts"
import { recoverHostTurn } from "./recover_host_turn.ts"
import { recoverDiscoveryWork } from "./recover_discovery_work.ts"
import { sendTerminalCallback } from "./send_terminal_callback.ts"
import { startHostTask } from "./start_host_task.ts"
import type { AppServerClient, HostAcceptance, HostCancellation, HostCancellationResult,
  HostConfiguration, HostDispatch, HostRecord, HostRecovery, HostRecoveryResult, TurnShape } from "./types.ts"
export class HostController {
  private finalizing = new Set<string>()
  private callbackTimers = new Set<string>()
  private notifications: Promise<void> = Promise.resolve()
  private budgetTimers = new Map<string, NodeJS.Timeout>()
  private budgetExhausted = new Set<string>()
  private readonly client: AppServerClient
  private readonly reviewClient?: AppServerClient
  private readonly ledger: HostLedger
  private readonly config: HostConfiguration
  private readonly callback: (record: HostRecord) => Promise<void>
  private readonly startTask: typeof startHostTask
  constructor(client: AppServerClient, ledger: HostLedger, config: HostConfiguration,
    callback: (record: HostRecord) => Promise<void> = sendTerminalCallback,
    reviewClient?: AppServerClient, taskStarter: typeof startHostTask = startHostTask) {
    if (reviewClient === client) throw new Error("review_app_server_boundary_invalid")
    this.client = client; this.reviewClient = reviewClient
    this.ledger = ledger; this.config = config; this.callback = callback
    this.startTask = taskStarter
  }
  async start(): Promise<void> {
    await this.ledger.load(); await this.client.connect()
    this.client.onNotification((notification) => {
      this.notifications = this.notifications.then(
        () => this.handleNotification(notification, "implementation")).catch(() => undefined)
    })
    if (this.reviewClient) {
      await this.reviewClient.connect()
      this.reviewClient.onNotification((notification) => {
        this.notifications = this.notifications.then(
          () => this.handleNotification(notification, "independent_reviewer"))
          .catch(() => undefined)
      })
    }
    for (const record of this.ledger.recoverable()) {
      try {
        if (record.state === "terminal") await this.deliverCallback(record)
        else {
          const accepted = record.state === "ambiguous"
            ? await this.ledger.accept(record.workId, record.threadId!, record.turnId!) : record
          this.scheduleBudget(accepted)
          await this.recover(accepted, true)
          if (accepted.state === "interactive") await this.clientFor(accepted).request(
            "thread/unsubscribe", { threadId: accepted.threadId })
        }
      } catch {
        // Durable records remain recoverable after a transient startup failure.
      }
    }
  }
  async dispatch(input: HostDispatch): Promise<HostAcceptance> {
    if (input.repository !== this.config.repository ||
      input.base_branch !== this.config.baseBranch) throw new Error("host_mapping_refused")
    const client = this.clientFor(input)
    const prior = this.ledger.get(input.work_id)
    const record = await this.ledger.reserve(input.work_id,
      dispatchFingerprint(input), input.capability_token, input.interaction_mode, input)
    if (prior) {
      if (record.threadId && record.turnId) {
        const resumed = record.state === "ambiguous"
          ? await this.ledger.accept(input.work_id, record.threadId, record.turnId) : record
        if (resumed.state === "terminal" && !resumed.callbackSent) {
          this.scheduleCallback(resumed)
        } else if (resumed.state === "accepted") {
          this.scheduleBudget(resumed)
          void this.recover(resumed).catch(() => undefined)
        }
        return { thread_id: record.threadId, turn_id: record.turnId }
      }
      throw new Error(record.state === "ambiguous"
        ? "host_start_ambiguous" : "host_dispatch_in_progress")
    }
    try {
      if (input.runtime_role === "independent_reviewer" && !input.review_thread_id) {
        for (const oldReview of this.ledger.recordsForImplementation(
          input.review_subject!.implementation_dispatch_id)) {
          if (oldReview.workId !== input.work_id && oldReview.state === "terminal" &&
            oldReview.callbackSent && oldReview.reviewResult?.result === "changes_requested" &&
            oldReview.reviewWorkspaceId && !oldReview.reviewWorkspaceCleanedAt) {
            await cleanupReviewWorkspace(this.config, oldReview)
            await this.ledger.reviewWorkspaceCleaned(oldReview.workId)
          }
        }
      }
      const started = await this.startTask(client, this.config, input, undefined, {
        threadStarted: (threadId) => this.ledger.threadStarted(input.work_id, threadId),
        turnStarted: (threadId, turnId) =>
          this.ledger.turnStarted(input.work_id, threadId, turnId),
      })
      const accepted = await this.ledger.accept(
        input.work_id, started.thread_id, started.turn_id)
      if (accepted.cancellationRequestedAt) {
        await this.reconcileCanceledStart(accepted, client)
        return started
      }
      this.scheduleBudget(accepted)
      void this.recover(accepted).catch(() => undefined)
      return started
    } catch (error) {
      if ((error instanceof Error && error.message === "host_start_ambiguous") ||
        Boolean(this.ledger.get(input.work_id)?.threadId)) {
        const ambiguous = await this.ledger.ambiguous(input.work_id)
        if (ambiguous.cancellationRequestedAt) {
          await this.reconcileCanceledStart(ambiguous, client)
        }
      } else {
        await this.ledger.releaseReserved(input.work_id)
      }
      throw error
    }
  }
  async cancel(input: HostCancellation): Promise<HostCancellationResult> {
    const result = await cancelHostWork((record) => this.clientFor(record),
      this.ledger, this.config, input)
    for (const targetWorkId of input.target_work_ids) {
      const target = this.ledger.get(targetWorkId)
      if (target?.state === "terminal" && !target.callbackSent) await this.deliverCallback(target)
    }
    return result
  }
  recoverDiscovery(input: HostRecovery): Promise<HostRecoveryResult> {
    return recoverDiscoveryWork(this.client, this.ledger, input, this.callback) }
  private handleNotification(notification: Record<string, unknown>,
    runtimeRole: "implementation" | "independent_reviewer"): Promise<void> {
    return handleHostNotification(notification, this.ledger, this.callback,
      (record, turn) => this.finalize(record, turn), runtimeRole)
  }
  private async recover(record: HostRecord, subscribe = false): Promise<void> {
    const turn = await recoverHostTurn(this.clientFor(record), record, subscribe)
    if (turn && turn.status !== "inProgress") await this.finalize(record, turn)
  }
  private async finalize(record: HostRecord, turn: TurnShape): Promise<void> {
    if (!record.threadId || this.finalizing.has(record.workId)) return
    if (record.recoveryRequestedAt) return
    this.finalizing.add(record.workId)
    const timer = this.budgetTimers.get(record.workId)
    if (timer) clearTimeout(timer)
    this.budgetTimers.delete(record.workId)
    try {
      const client = this.clientFor(record)
      if (record.interactionMode === "interactive" && !record.cancellationRequestedAt) {
        await client.request("thread/unsubscribe", { threadId: record.threadId })
        await this.ledger.retainInteractive(record.workId); return
      }
      await client.request("thread/archive", { threadId: record.threadId })
      const archivedAt = new Date().toISOString()
      let reviewResult = record.runtimeRole === "independent_reviewer"
        ? extractReviewResult(turn) : null
      let summary = record.runtimeRole === "independent_reviewer"
        ? reviewResult
          ? { readiness_result: "ready" as const, terminal_disposition: "completed" as const,
            summary: `Independent review completed with result ${reviewResult.result}.` }
          : { readiness_result: "failed" as const, terminal_disposition: "failed" as const,
            summary: "Independent reviewer ended without a valid typed review result." }
        : extractTerminalSummary(turn)
      const telemetry = buildAttemptTelemetry(record, turn, summary.terminal_disposition)
      const budget = this.budgetExhausted.has(record.workId)
        ? "budget_elapsed_exhausted" : budgetDisposition(record, telemetry)
      this.budgetExhausted.delete(record.workId)
      if (budget) {
        summary = { readiness_result: "failed", terminal_disposition: "failed",
          summary: `${budget}; the durable checkpoint is preserved for operator-directed resume.` }
        reviewResult = null
      }
      telemetry.disposition = summary.terminal_disposition
      await this.ledger.recordTelemetry(record.workId, telemetry)
      const terminal = await this.ledger.terminal(record.workId, summary, archivedAt, reviewResult)
      await this.deliverCallback(terminal)
    } finally {
      this.finalizing.delete(record.workId)
    }
  }
  private async deliverCallback(record: HostRecord): Promise<void> {
    if (record.runtimeRole !== "independent_reviewer") {
      await this.cleanupReviewLineage(record.workId)
    }
    if (!record.callbackSent) {
      await this.callback(record); await this.ledger.callbackSent(record.workId)
    }
    if (record.runtimeRole === "independent_reviewer" &&
      record.reviewResult?.result !== "changes_requested" &&
      record.reviewWorkspaceId && !record.reviewWorkspaceCleanedAt) {
      await cleanupReviewWorkspace(this.config, record)
      await this.ledger.reviewWorkspaceCleaned(record.workId)
    }
  }
  private async cleanupReviewLineage(implementationDispatchId: string): Promise<void> {
    for (const review of this.ledger.recordsForImplementation(implementationDispatchId)) {
      if (review.state === "terminal" && review.callbackSent && review.reviewWorkspaceId &&
        !review.reviewWorkspaceCleanedAt) {
        await cleanupReviewWorkspace(this.config, review)
        await this.ledger.reviewWorkspaceCleaned(review.workId)
      }
    }
  }
  private scheduleCallback(record: HostRecord): void {
    if (this.callbackTimers.has(record.workId)) return
    this.callbackTimers.add(record.workId)
    setTimeout(() => {
      this.callbackTimers.delete(record.workId)
      void this.deliverCallback(record).catch(() => undefined)
    }, 1000)
  }
  private scheduleBudget(record: HostRecord): void {
    if (!record.budget || !record.threadId || !record.turnId ||
      this.budgetTimers.has(record.workId)) return
    const remaining = Math.max(0, record.budget.elapsed_ms -
      (Date.now() - Date.parse(record.startedAt ?? record.updatedAt)))
    const timer = setTimeout(() => {
      this.budgetTimers.delete(record.workId)
      this.budgetExhausted.add(record.workId)
      void this.clientFor(record).request("turn/interrupt", {
        threadId: record.threadId, turnId: record.turnId,
      }).catch(() => undefined)
    }, remaining)
    timer.unref()
    this.budgetTimers.set(record.workId, timer)
  }
  private clientFor(record: Pick<HostRecord, "runtimeRole"> |
    Pick<HostDispatch, "runtime_role">): AppServerClient {
    const runtimeRole = "runtimeRole" in record ? record.runtimeRole : record.runtime_role
    if (runtimeRole === "independent_reviewer") {
      if (!this.reviewClient) throw new Error("review_app_server_boundary_missing")
      return this.reviewClient
    }
    return this.client
  }
  private async reconcileCanceledStart(record: HostRecord,
    client: AppServerClient): Promise<void> {
    const current = this.ledger.get(record.workId)
    if (!current?.cancellationRequestedAt) return
    if (current.threadId && current.turnId && !current.interruptionRequestedAt) {
      await client.request("turn/interrupt", {
        threadId: current.threadId, turnId: current.turnId,
      })
      await this.ledger.interruptionRequested(current.workId)
    }
    await this.ledger.retireCanceledStart(current.workId)
  }
}
