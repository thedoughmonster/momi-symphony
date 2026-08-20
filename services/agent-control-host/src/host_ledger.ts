import type { HostCancellationRecord, HostRecord, HostRecoveryRecord, TerminalSummary } from "./types.ts"
import { readHostLedger } from "./read_host_ledger.ts"
import { writeHostLedger } from "./write_host_ledger.ts"

export class HostLedger {
  private records = new Map<string, HostRecord>()
  private cancellations = new Map<string, HostCancellationRecord>()
  private recoveries = new Map<string, HostRecoveryRecord>()
  private queue: Promise<void> = Promise.resolve()
  private readonly path: string
  constructor(path: string) { this.path = path }
  async load(): Promise<void> {
    const parsed = await readHostLedger(this.path)
    for (const record of parsed.records ?? []) this.records.set(record.workId, record)
    for (const record of parsed.cancellations ?? []) {
      record.targetWorkIds ??= record.targetWorkId ? [record.targetWorkId] : []
      this.cancellations.set(record.workId, record)
    }
    for (const record of parsed.recoveries ?? []) this.recoveries.set(record.workId, record)
  }
  get(workId: string): HostRecord | null { return this.records.get(workId) ?? null }
  getCancellation(workId: string): HostCancellationRecord | null {
    return this.cancellations.get(workId) ?? null }
  getRecovery(workId: string): HostRecoveryRecord | null { return this.recoveries.get(workId) ?? null }
  findByThread(threadId: string): HostRecord | null {
    return [...this.records.values()].find((record) => record.threadId === threadId) ?? null }
  recordsForImplementation(implementationDispatchId: string): HostRecord[] {
    return [...this.records.values()].filter((record) =>
      record.reviewSubject?.implementation_dispatch_id === implementationDispatchId)
  }
  async reserveCancellation(workId: string, fingerprint: string,
    targetWorkIds: string[]): Promise<HostCancellationRecord | null> {
    const existing = this.cancellations.get(workId)
    if (existing) {
      if (existing.fingerprint !== fingerprint ||
        existing.targetWorkIds.join("\n") !== targetWorkIds.join("\n"))
        throw new Error("host_idempotency_conflict")
      return existing
    }
    this.cancellations.set(workId, { workId, fingerprint, targetWorkIds,
      state: "reserved", updatedAt: new Date().toISOString() })
    await this.persist(); return null
  }
  async completeCancellation(workId: string, state: "requested" | "already_terminal"): Promise<void> {
    const record = this.cancellations.get(workId)
    if (!record) throw new Error("host_cancellation_missing")
    record.state = state; record.updatedAt = new Date().toISOString(); await this.persist()
  }
  async reserveRecovery(workId: string, fingerprint: string,
    targetWorkId: string): Promise<HostRecoveryRecord | null> {
    const existing = this.recoveries.get(workId)
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.targetWorkId !== targetWorkId)
        throw new Error("host_idempotency_conflict")
      return existing
    }
    this.recoveries.set(workId, { workId, fingerprint, targetWorkId,
      state: "reserved", updatedAt: new Date().toISOString() })
    await this.persist(); return null
  }
  async completeRecovery(workId: string, state: "recovered" | "already_archived"): Promise<void> {
    const record = this.recoveries.get(workId)
    if (!record) throw new Error("host_recovery_missing")
    record.state = state; record.updatedAt = new Date().toISOString(); await this.persist()
  }
  recoverable(): HostRecord[] {
    return [...this.records.values()].filter((record) =>
      record.state === "accepted" || record.state === "interactive" ||
      (record.state === "ambiguous" && Boolean(record.threadId && record.turnId)) ||
      (record.state === "terminal" && (!record.callbackSent ||
        (record.runtimeRole === "independent_reviewer" &&
          record.reviewResult?.result !== "changes_requested" &&
          Boolean(record.reviewWorkspaceId) && !record.reviewWorkspaceCleanedAt))))
  }
  activeWorkIds(): string[] {
    return [...this.records.values()]
      .filter((record) => record.state === "reserved" || record.state === "accepted" ||
        record.state === "interactive" || record.state === "ambiguous" ||
        (record.state === "terminal" && !record.callbackSent))
      .map((record) => record.workId)
      .sort()
      .slice(0, 128)
  }
  async reserve(workId: string, fingerprint: string, token: string,
    interactionMode: "one_shot" | "interactive" = "one_shot",
    dispatch?: Pick<import("./types.ts").HostDispatch, "budget" | "policy_version" |
      "stable_prefix_fingerprint" | "context_fingerprint" | "runtime_role" |
      "review_subject" | "review_workspace_id">,
  ): Promise<HostRecord> {
    const existing = this.records.get(workId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("host_idempotency_conflict")
      if (existing.capabilityToken !== token) {
        existing.capabilityToken = token; existing.updatedAt = new Date().toISOString()
        await this.persist()
      }
      return existing
    }
    const record: HostRecord = { workId, fingerprint, capabilityToken: token,
      state: "reserved", interactionMode, threadId: null, turnId: null, terminal: null,
      callbackSent: false, cancellationRequestedAt: null, recoveryRequestedAt: null,
      budget: dispatch?.budget, policyVersion: dispatch?.policy_version,
      stablePrefixFingerprint: dispatch?.stable_prefix_fingerprint,
      contextFingerprint: dispatch?.context_fingerprint,
      runtimeRole: dispatch?.runtime_role ?? "implementation",
      reviewSubject: dispatch?.review_subject, reviewResult: null,
      reviewWorkspaceId: dispatch?.review_workspace_id,
      reviewWorkspaceCleanedAt: null,
      telemetry: null, startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString() }
    this.records.set(workId, record)
    await this.persist(); return record
  }
  async accept(workId: string, threadId: string, turnId: string): Promise<HostRecord> {
    const record = this.require(workId)
    if ((record.threadId && record.threadId !== threadId) ||
      (record.turnId && record.turnId !== turnId)) throw new Error("host_idempotency_conflict")
    record.state = "accepted"; record.threadId = threadId; record.turnId = turnId
    record.updatedAt = new Date().toISOString(); await this.persist(); return record
  }
  async ambiguous(workId: string): Promise<void> {
    const record = this.require(workId); record.state = "ambiguous"
    record.updatedAt = new Date().toISOString(); await this.persist() }
  async retainInteractive(workId: string): Promise<void> {
    const record = this.require(workId)
    if (record.interactionMode !== "interactive") throw new Error("host_interaction_mode_conflict")
    record.state = "interactive"; record.updatedAt = new Date().toISOString(); await this.persist()
  }
  async terminal(workId: string, result: TerminalSummary, archivedAt: string,
    reviewResult?: import("./types.ts").HostReviewResult | null): Promise<HostRecord> {
    const record = this.require(workId)
    record.state = "terminal"; record.terminal = { ...result, archivedAt }
    record.reviewResult = reviewResult ?? null
    record.callbackSent = false; record.updatedAt = new Date().toISOString(); await this.persist(); return record
  }
  async recordTelemetry(workId: string,
    telemetry: import("./types.ts").AttemptTelemetry): Promise<void> {
    const record = this.require(workId); record.telemetry = telemetry
    record.updatedAt = new Date().toISOString(); await this.persist()
  }
  async callbackSent(workId: string): Promise<void> {
    const record = this.require(workId); record.callbackSent = true
    record.updatedAt = new Date().toISOString(); await this.persist() }
  async reviewWorkspaceCleaned(workId: string): Promise<void> {
    const record = this.require(workId); record.reviewWorkspaceCleanedAt = new Date().toISOString()
    record.updatedAt = new Date().toISOString(); await this.persist() }
  async cancellationRequested(workId: string): Promise<void> {
    const record = this.require(workId); record.cancellationRequestedAt ??= new Date().toISOString()
    record.updatedAt = new Date().toISOString(); await this.persist() }
  async recoveryRequested(workId: string): Promise<void> {
    const record = this.require(workId); record.recoveryRequestedAt ??= new Date().toISOString()
    record.updatedAt = new Date().toISOString(); await this.persist() }
  private require(workId: string): HostRecord {
    const record = this.records.get(workId); if (!record) throw new Error("host_record_missing")
    return record }
  private async persist(): Promise<void> {
    this.queue = this.queue.then(() => writeHostLedger(this.path, [...this.records.values()],
      [...this.cancellations.values()], [...this.recoveries.values()]))
    await this.queue
  }
}
