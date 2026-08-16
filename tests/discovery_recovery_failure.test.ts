import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HostController } from "../src/host_controller.ts"
import { HostLedger } from "../src/host_ledger.ts"
import { parseHostRecovery } from "../src/parse_host_recovery.ts"
import type { AppServerClient, HostRecovery, TurnShape } from "../src/types.ts"

class FailingAppServer implements AppServerClient {
  archiveFailures = 1
  turns: TurnShape[] = [{ id: "initial", status: "completed", items: [] }]
  connect(): Promise<void> { return Promise.resolve() }
  onNotification(): void {}
  request<T>(method: string): Promise<T> {
    if (method === "thread/read") return Promise.resolve(
      { thread: { turns: this.turns } } as T)
    if (method === "thread/archive" && this.archiveFailures-- > 0) {
      return Promise.reject(new Error("archive_failed"))
    }
    return Promise.resolve({} as T)
  }
}

const target = "00000000-0000-4000-8000-000000000011"
const input: HostRecovery = { schema_version: 1,
  work_id: "00000000-0000-4000-8000-000000000012",
  capability_token: "00000000-0000-4000-8000-000000000013",
  target_work_id: target }

test("archive failure retains ownership and the same recovery retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-discovery-retry-"))
  const client = new FailingAppServer(); const ledger = new HostLedger(join(directory, "ledger"))
  const controller = new HostController(client, ledger, { workspaceRoot: "/workspace",
    repository: "thedoughmonster/momi-backend", baseBranch: "dev" }, () => Promise.resolve())
  try {
    await controller.start(); await ledger.reserve(target, "fingerprint", "token", "interactive")
    await ledger.accept(target, "thread", "initial"); await ledger.retainInteractive(target)
    await assert.rejects(controller.recoverDiscovery(input), /archive_failed/)
    assert.equal(ledger.get(target)?.state, "interactive")
    assert.equal(ledger.getRecovery(input.work_id)?.state, "reserved")
    assert.deepEqual(await controller.recoverDiscovery(input), { recovery_state: "recovered" })
    assert.equal(ledger.get(target)?.state, "terminal")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("invalid recovery targets are actionable and do not reserve host work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-discovery-invalid-"))
  const client = new FailingAppServer(); const ledger = new HostLedger(join(directory, "ledger"))
  const controller = new HostController(client, ledger, { workspaceRoot: "/workspace",
    repository: "thedoughmonster/momi-backend", baseBranch: "dev" }, () => Promise.resolve())
  try {
    await controller.start()
    assert.deepEqual(await controller.recoverDiscovery(input), { recovery_state: "no_target" })
    await ledger.reserve(target, "fingerprint", "token")
    assert.deepEqual(await controller.recoverDiscovery(input),
      { recovery_state: "ambiguous_target" })
    assert.equal(ledger.getRecovery(input.work_id), null)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("recovery input is strict", () => {
  assert.deepEqual(parseHostRecovery(input), input)
  assert.equal(parseHostRecovery({ ...input, extra: true }), null)
})
