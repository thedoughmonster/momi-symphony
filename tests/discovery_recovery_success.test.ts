import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HostController } from "../src/host_controller.ts"
import { HostLedger } from "../src/host_ledger.ts"
import type { AppServerClient, HostRecovery, TurnShape } from "../src/types.ts"

class FakeAppServer implements AppServerClient {
  requests: Array<{ method: string; params: unknown }> = []
  turns: TurnShape[] = []
  connect(): Promise<void> { return Promise.resolve() }
  onNotification(): void {}
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === "turn/interrupt") {
      this.turns = this.turns.map((turn) => turn.status === "inProgress"
        ? { ...turn, status: "interrupted" } : turn)
    }
    if (method === "thread/read") return Promise.resolve(
      { thread: { turns: this.turns } } as T)
    return Promise.resolve({} as T)
  }
}

const target = "00000000-0000-4000-8000-000000000001"
const input: HostRecovery = { schema_version: 1,
  work_id: "00000000-0000-4000-8000-000000000002",
  capability_token: "00000000-0000-4000-8000-000000000003",
  target_work_id: target }

test("completed discovery recovery archives once and replays safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-discovery-recovery-"))
  const client = new FakeAppServer(); const ledger = new HostLedger(join(directory, "ledger"))
  client.turns = [{ id: "initial", status: "completed", items: [] }]
  let callbacks = 0
  const controller = new HostController(client, ledger, { workspaceRoot: "/workspace",
    repository: "thedoughmonster/momi-backend", baseBranch: "dev" },
  () => { callbacks += 1; return Promise.resolve() })
  try {
    await controller.start(); await ledger.reserve(target, "fingerprint", "token", "interactive")
    await ledger.accept(target, "thread", "initial"); await ledger.retainInteractive(target)
    assert.deepEqual(await controller.recoverDiscovery(input), { recovery_state: "recovered" })
    assert.deepEqual(await controller.recoverDiscovery(input), { recovery_state: "recovered" })
    assert.equal(client.requests.filter((item) => item.method === "thread/archive").length, 1)
    assert.equal(client.requests.some((item) => item.method === "thread/start"), false)
    assert.equal(ledger.get(target)?.state, "terminal"); assert.equal(callbacks, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("running follow-up is interrupted and confirmed before archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-discovery-running-"))
  const client = new FakeAppServer(); const ledger = new HostLedger(join(directory, "ledger"))
  client.turns = [{ id: "initial", status: "completed", items: [] },
    { id: "follow-up", status: "inProgress", items: [] }]
  const controller = new HostController(client, ledger, { workspaceRoot: "/workspace",
    repository: "thedoughmonster/momi-backend", baseBranch: "dev" }, () => Promise.resolve())
  try {
    await controller.start(); await ledger.reserve(target, "fingerprint", "token", "interactive")
    await ledger.accept(target, "thread", "initial"); await ledger.retainInteractive(target)
    assert.deepEqual(await controller.recoverDiscovery({ ...input,
      work_id: "00000000-0000-4000-8000-000000000004" }),
    { recovery_state: "recovered" })
    const interrupted = client.requests.find((item) => item.method === "turn/interrupt")
    assert.deepEqual(interrupted?.params, { threadId: "thread", turnId: "follow-up" })
    const methods = client.requests.map((item) => item.method)
    assert.ok(methods.lastIndexOf("thread/read") < methods.indexOf("thread/archive"))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("an already archived retained task is replay-safe success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-discovery-archived-"))
  const client = new FakeAppServer(); const ledger = new HostLedger(join(directory, "ledger"))
  const controller = new HostController(client, ledger, { workspaceRoot: "/workspace",
    repository: "thedoughmonster/momi-backend", baseBranch: "dev" }, () => Promise.resolve())
  try {
    await controller.start(); await ledger.reserve(target, "fingerprint", "token", "interactive")
    await ledger.accept(target, "thread", "initial")
    await ledger.terminal(target, { readiness_result: "ready",
      terminal_disposition: "completed", summary: "Archived." }, new Date().toISOString())
    await ledger.callbackSent(target)
    const archivedInput = { ...input, work_id: "00000000-0000-4000-8000-000000000005" }
    assert.deepEqual(await controller.recoverDiscovery(archivedInput),
      { recovery_state: "already_archived" })
    assert.deepEqual(await controller.recoverDiscovery(archivedInput),
      { recovery_state: "already_archived" })
    assert.equal(client.requests.some((item) => item.method === "thread/archive"), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
