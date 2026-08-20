import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HostController } from "../src/host_controller.ts"
import { HostLedger } from "../src/host_ledger.ts"
import { parseHostCancellation } from "../src/parse_host_cancellation.ts"
import type { AppServerClient, HostCancellation } from "../src/types.ts"

class FakeAppServer implements AppServerClient {
  requests: Array<{ method: string; params: unknown }> = []
  connect(): Promise<void> { return Promise.resolve() }
  onNotification(): void {}
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params }); return Promise.resolve({} as T)
  }
}

test("cancellation transport normalizes v1 and requires sorted exact v2 targets", () => {
  const common = { work_id: "00000000-0000-4000-8000-000000000031",
    capability_token: "00000000-0000-4000-8000-000000000032",
    repository: "thedoughmonster/momi-symphony", base_branch: "main" }
  const first = "00000000-0000-4000-8000-000000000033"
  const second = "00000000-0000-4000-8000-000000000034"
  assert.deepEqual(parseHostCancellation({ schema_version: 1, ...common,
    target_work_id: first }), { schema_version: 2, ...common, target_work_ids: [first] })
  assert.deepEqual(parseHostCancellation({ schema_version: 2, ...common,
    target_work_ids: [first, second] }), { schema_version: 2, ...common,
    target_work_ids: [first, second] })
  assert.equal(parseHostCancellation({ schema_version: 2, ...common,
    target_work_ids: [second, first] }), null)
})

test("active, replayed, and terminal cancellation are idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-cancel-"))
  const ledger = new HostLedger(join(directory, "ledger.json"))
  const client = new FakeAppServer()
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, () => Promise.resolve())
  const target = "00000000-0000-4000-8000-000000000001"
  const input: HostCancellation = { schema_version: 2,
    work_id: "00000000-0000-4000-8000-000000000002",
    capability_token: "00000000-0000-4000-8000-000000000003",
    target_work_ids: [target], repository: "thedoughmonster/momi-symphony",
    base_branch: "main" }
  try {
    await controller.start()
    await ledger.reserve(target, "fingerprint", "token")
    await ledger.accept(target, "thread-1", "turn-1")
    assert.deepEqual(await controller.cancel(input), { cancellation_state: "requested" })
    assert.deepEqual(await controller.cancel(input), { cancellation_state: "requested" })
    assert.equal(client.requests.filter((item) => item.method === "turn/interrupt").length, 1)
    await assert.rejects(controller.cancel({ ...input,
      target_work_ids: ["00000000-0000-4000-8000-000000000009"] }),
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

test("one exact lifecycle cancellation interrupts its owned target set once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-cancel-tree-"))
  const ledger = new HostLedger(join(directory, "ledger.json"))
  const client = new FakeAppServer()
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, () => Promise.resolve())
  const targets = ["00000000-0000-4000-8000-000000000021",
    "00000000-0000-4000-8000-000000000022"]
  const input: HostCancellation = { schema_version: 2,
    work_id: "00000000-0000-4000-8000-000000000023",
    capability_token: "00000000-0000-4000-8000-000000000024",
    target_work_ids: targets, repository: "thedoughmonster/momi-symphony",
    base_branch: "main" }
  try {
    await controller.start()
    for (const [index, target] of targets.entries()) {
      await ledger.reserve(target, `fingerprint-${index}`, "token")
      await ledger.accept(target, `thread-${index}`, `turn-${index}`)
    }
    assert.deepEqual(await controller.cancel(input), { cancellation_state: "requested" })
    assert.deepEqual(await controller.cancel(input), { cancellation_state: "requested" })
    assert.equal(client.requests.filter((item) => item.method === "turn/interrupt").length, 2)
    assert.deepEqual(targets.map((target) => Boolean(ledger.get(target)?.cancellationRequestedAt)),
      [true, true])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("retained discovery cancellation archives the task and delivers its terminal receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-discovery-cancel-"))
  const ledger = new HostLedger(join(directory, "ledger.json")); const client = new FakeAppServer()
  let callbacks = 0
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, () => { callbacks += 1; return Promise.resolve() })
  const target = "00000000-0000-4000-8000-000000000011"
  const input: HostCancellation = { schema_version: 2,
    work_id: "00000000-0000-4000-8000-000000000012",
    capability_token: "00000000-0000-4000-8000-000000000013",
    target_work_ids: [target], repository: "thedoughmonster/momi-symphony", base_branch: "main" }
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
