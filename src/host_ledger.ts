import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { HostRecord, TerminalSummary } from "./types.ts"

export class HostLedger {
  private records = new Map<string, HostRecord>()
  private queue: Promise<void> = Promise.resolve()
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    let parsed: { records?: HostRecord[] } = {}
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    for (const record of parsed.records ?? []) this.records.set(record.workId, record)
  }

  get(workId: string): HostRecord | null {
    return this.records.get(workId) ?? null
  }

  recoverable(): HostRecord[] {
    return [...this.records.values()].filter((record) =>
      record.state === "accepted" ||
      (record.state === "ambiguous" && Boolean(record.threadId && record.turnId)) ||
      (record.state === "terminal" && !record.callbackSent))
  }

  async reserve(workId: string, fingerprint: string, token: string): Promise<HostRecord> {
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
      state: "reserved", threadId: null, turnId: null, terminal: null,
      callbackSent: false, updatedAt: new Date().toISOString() }
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

  private require(workId: string): HostRecord {
    const record = this.records.get(workId)
    if (!record) throw new Error("host_record_missing")
    return record
  }

  private async persist(): Promise<void> {
    this.queue = this.queue.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify({ records: [...this.records.values()] }, null, 2),
        { encoding: "utf8", mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.path)
    })
    await this.queue
  }
}
