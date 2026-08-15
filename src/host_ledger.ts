import type { HostCancellationRecord, HostRecord, TerminalSummary } from "./types.ts"
import { readHostLedger } from "./read_host_ledger.ts"
import { writeHostLedger } from "./write_host_ledger.ts"

export class HostLedger {
  private records = new Map<string, HostRecord>()
  private cancellations = new Map<string, HostCancellationRecord>()
  private queue: Promise<void> = Promise.resolve()
  private readonly path: string
  constructor(path: string) { this.path = path }
  async load(): Promise<void> {
    const parsed = await readHostLedger(this.path)
    for (const record of parsed.records ?? []) this.records.set(record.workId, record)
    for (const record of parsed.cancellations ?? []) this.cancellations.set(record.workId, record)
  }
  get(workId: string): HostRecord | null {
    return this.records.get(workId) ?? null
  }
  getCancellation(workId: string): HostCancellationRecord | null {
    return this.cancellations.get(workId) ?? null
  }
  findByThread(threadId: string): HostRecord | null {
    return [...this.records.values()].find((record) => record.threadId === threadId) ?? null
  }
  async reserveCancellation(
    workId: string, fingerprint: string, targetWorkId: string,
  ): Promise<HostCancellationRecord | null> {
    const existing = this.cancellations.get(workId)
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.targetWorkId !== targetWorkId) {
        throw new Error("host_idempotency_conflict")
      }
      return existing
    }
    this.cancellations.set(workId, { workId, fingerprint, targetWorkId,
      state: "reserved", updatedAt: new Date().toISOString() })
    await this.persist(); return null
  }
  async completeCancellation(
    workId: string, state: "requested" | "already_terminal",
  ): Promise<void> {
    const record = this.cancellations.get(workId)
    if (!record) throw new Error("host_cancellation_missing")
    record.state = state; record.updatedAt = new Date().toISOString()
    await this.persist()
  }
  recoverable(): HostRecord[] {
    return [...this.records.values()].filter((record) =>
      record.state === "accepted" ||
      (record.state === "ambiguous" && Boolean(record.threadId && record.turnId)) ||
      (record.state === "terminal" && !record.callbackSent))
  }
  async reserve(
    workId: string, fingerprint: string, token: string,
    interactionMode: "one_shot" | "interactive" = "one_shot",
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
      callbackSent: false, cancellationRequestedAt: null,
      updatedAt: new Date().toISOString() }
    this.records.set(workId, record)
    await this.persist()
    return record
  }
  async accept(workId: string, threadId: string, turnId: string): Promise<HostRecord> {
    const record = this.require(workId)
    if ((record.threadId && record.threadId !== threadId) ||
      (record.turnId && record.turnId !== turnId)) throw new Error("host_idempotency_conflict")
    record.state = "accepted"; record.threadId = threadId; record.turnId = turnId
    record.updatedAt = new Date().toISOString(); await this.persist(); return record
  }
  async ambiguous(workId: string): Promise<void> {
    const record = this.require(workId)
    record.state = "ambiguous"; record.updatedAt = new Date().toISOString()
    await this.persist()
  }
  async retainInteractive(workId: string): Promise<void> {
    const record = this.require(workId)
    if (record.interactionMode !== "interactive") {
      throw new Error("host_interaction_mode_conflict")
    }
    record.state = "interactive"; record.updatedAt = new Date().toISOString()
    await this.persist()
  }
  async terminal(workId: string, result: TerminalSummary, archivedAt: string): Promise<HostRecord> {
    const record = this.require(workId)
    record.state = "terminal"; record.terminal = { ...result, archivedAt }
    record.callbackSent = false; record.updatedAt = new Date().toISOString()
    await this.persist(); return record
  }
  async callbackSent(workId: string): Promise<void> {
    const record = this.require(workId)
    record.callbackSent = true; record.updatedAt = new Date().toISOString()
    await this.persist()
  }
  async cancellationRequested(workId: string): Promise<void> {
    const record = this.require(workId)
    record.cancellationRequestedAt ??= new Date().toISOString()
    record.updatedAt = new Date().toISOString(); await this.persist()
  }
  private require(workId: string): HostRecord {
    const record = this.records.get(workId)
    if (!record) throw new Error("host_record_missing")
    return record
  }
  private async persist(): Promise<void> {
    this.queue = this.queue.then(() => writeHostLedger(this.path,
      [...this.records.values()], [...this.cancellations.values()]))
    await this.queue
  }
}
