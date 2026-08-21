import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { cancelHostWork } from "../src/cancel_host_work.ts"
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

const config = { workspaceRoot: "/workspace",
  repository: "thedoughmonster/momi-symphony", baseBranch: "main" }
const common = { work_id: "00000000-0000-4000-8000-000000000031",
  capability_token: "00000000-0000-4000-8000-000000000032",
  repository: config.repository, base_branch: config.baseBranch }

test("cancellation transport normalizes v1 and requires sorted exact v2 targets", () => {
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

test("database-authoritative cancellation interrupts known host work idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-cancel-"))
  const ledger = new HostLedger(join(directory, "ledger.json"))
  const client = new FakeAppServer()
  const target = "00000000-0000-4000-8000-000000000041"
  const input = { schema_version: 2, ...common, target_work_ids: [target] } as HostCancellation
  try {
    await ledger.reserve(target, "fingerprint", "token")
    await ledger.threadStarted(target, "thread-1")
    await ledger.turnStarted(target, "thread-1", "turn-1")
    assert.deepEqual(await cancelHostWork(client, ledger, config, input),
      { cancellation_state: "requested" })
    assert.equal(ledger.get(target)?.state, "canceled")
    assert.equal(client.requests.filter((request) => request.method === "turn/interrupt").length, 1)
    assert.deepEqual(await cancelHostWork(client, ledger, config, input),
      { cancellation_state: "requested" })
    assert.equal(client.requests.filter((request) => request.method === "turn/interrupt").length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("missing targets and interruption failures remain best-effort cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-cancel-best-effort-"))
  const ledger = new HostLedger(join(directory, "ledger.json"))
  const missing = "00000000-0000-4000-8000-000000000051"
  const input = { schema_version: 2, ...common, target_work_ids: [missing] } as HostCancellation
  const failing: AppServerClient = { connect: () => Promise.resolve(), onNotification: () => {},
    request: () => Promise.reject(new Error("offline")) }
  try {
    assert.deepEqual(await cancelHostWork(failing, ledger, config, input),
      { cancellation_state: "requested" })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
