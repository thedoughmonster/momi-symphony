import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HostController } from "../src/host_controller.ts"
import { HostLedger } from "../src/host_ledger.ts"
import type { AppServerClient, HostCancellation } from "../src/types.ts"

class FakeAppServer implements AppServerClient {
  requests: Array<{ method: string; params: unknown }> = []
  connect(): Promise<void> { return Promise.resolve() }
  onNotification(): void {}
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params }); return Promise.resolve({} as T)
  }
}

test("active, replayed, and terminal cancellation are idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-cancel-"))
  const ledger = new HostLedger(join(directory, "ledger.json"))
  const client = new FakeAppServer()
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-backend",
    baseBranch: "dev",
  }, () => Promise.resolve())
  const target = "00000000-0000-4000-8000-000000000001"
  const input: HostCancellation = { schema_version: 1,
    work_id: "00000000-0000-4000-8000-000000000002",
    capability_token: "00000000-0000-4000-8000-000000000003",
    target_work_id: target, repository: "thedoughmonster/momi-backend",
    base_branch: "dev" }
  try {
    await controller.start()
    await ledger.reserve(target, "fingerprint", "token")
    await ledger.accept(target, "thread-1", "turn-1")
    assert.deepEqual(await controller.cancel(input), { cancellation_state: "requested" })
    assert.deepEqual(await controller.cancel(input), { cancellation_state: "requested" })
    assert.equal(client.requests.filter((item) => item.method === "turn/interrupt").length, 1)
    await assert.rejects(controller.cancel({ ...input,
      target_work_id: "00000000-0000-4000-8000-000000000009" }),
    /host_idempotency_conflict/)
    await ledger.terminal(target, { readiness_result: "ready",
      terminal_disposition: "interrupted", summary: "Cancelled." }, new Date().toISOString())
    assert.deepEqual(await controller.cancel({ ...input,
      work_id: "00000000-0000-4000-8000-000000000004" }),
    { cancellation_state: "already_terminal" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("retained discovery cancellation archives the task and delivers its terminal receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-discovery-cancel-"))
  const ledger = new HostLedger(join(directory, "ledger.json")); const client = new FakeAppServer()
  let callbacks = 0
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-backend",
    baseBranch: "dev",
  }, () => { callbacks += 1; return Promise.resolve() })
  const target = "00000000-0000-4000-8000-000000000011"
  const input: HostCancellation = { schema_version: 1,
    work_id: "00000000-0000-4000-8000-000000000012",
    capability_token: "00000000-0000-4000-8000-000000000013",
    target_work_id: target, repository: "thedoughmonster/momi-backend", base_branch: "dev" }
  try {
    await controller.start(); await ledger.reserve(target, "fingerprint", "token", "interactive")
    await ledger.accept(target, "thread-discovery", "turn-discovery")
    await ledger.retainInteractive(target)
    assert.deepEqual(await controller.cancel(input), { cancellation_state: "requested" })
    assert.equal(client.requests.filter((item) => item.method === "thread/archive").length, 1)
    assert.equal(ledger.get(target)?.state, "terminal")
    assert.notEqual(ledger.get(target)?.cancellationRequestedAt, null)
    assert.equal(ledger.get(target)?.callbackSent, true)
    assert.equal(callbacks, 1)
    assert.deepEqual(await controller.cancel(input), { cancellation_state: "requested" })
    assert.equal(client.requests.filter((item) => item.method === "thread/archive").length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
