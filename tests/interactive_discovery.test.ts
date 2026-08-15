import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HostController } from "../src/host_controller.ts"
import { HostLedger } from "../src/host_ledger.ts"
import type { AppServerClient, HostDispatch, HostRecord } from "../src/types.ts"

class FakeAppServer implements AppServerClient {
  requests: Array<{ method: string; params: unknown }> = []
  listener: (notification: Record<string, unknown>) => void = () => undefined
  connect(): Promise<void> { return Promise.resolve() }
  onNotification(listener: (notification: Record<string, unknown>) => void): void {
    this.listener = listener
  }
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === "thread/start") return Promise.resolve(
      { thread: { id: "thread-discovery-1" } } as T)
    if (method === "turn/start") return Promise.resolve(
      { turn: { id: "turn-discovery-1" } } as T)
    if (method === "thread/read" || method === "thread/resume") return Promise.resolve(
      { thread: { turns: [] } } as T)
    return Promise.resolve({} as T)
  }
  emit(notification: Record<string, unknown>): void { this.listener(notification) }
}

test("discovery is named, conversational, retained, replayed, and manually archived", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-interactive-discovery-"))
  const client = new FakeAppServer(); const ledger = new HostLedger(join(directory, "ledger.json"))
  let callbackRecord: HostRecord | null = null
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-backend",
    baseBranch: "dev",
  }, async (record) => { callbackRecord = record })
  const dispatch: HostDispatch = { schema_version: 2,
    interaction_mode: "interactive", thread_name: "MOX-159 · interactive discovery",
    work_id: "00000000-0000-4000-8000-000000000001",
    capability_token: "00000000-0000-4000-8000-000000000002",
    issue_id: "00000000-0000-4000-8000-000000000003", issue_identifier: "MOX-159",
    issue_url: "https://linear.app/x/issue/MOX-159/x",
    project_id: "00000000-0000-4000-8000-000000000004",
    project_name: "Backend Stabilization", repository: "thedoughmonster/momi-backend",
    base_branch: "dev", active_states: ["In Progress"],
    instruction: "Ask one concise discovery question and remain available for follow-up." }
  try {
    await controller.start()
    const accepted = await controller.dispatch(dispatch)
    assert.deepEqual(accepted, { thread_id: "thread-discovery-1", turn_id: "turn-discovery-1" })
    const named = client.requests.find((item) => item.method === "thread/name/set")
    assert.deepEqual(named?.params, { threadId: "thread-discovery-1",
      name: "MOX-159 · interactive discovery" })
    const started = client.requests.find((item) => item.method === "turn/start")
    assert.equal("outputSchema" in (started?.params as Record<string, unknown>), false)
    assert.equal(client.requests.some((item) => item.method === "thread/read"), true)
    assert.equal(client.requests.some((item) => item.method === "thread/resume"), false)
    client.emit({ method: "turn/completed", params: { threadId: "thread-discovery-1",
      turn: { id: "turn-discovery-1", status: "completed", items: [
        { type: "agentMessage", text: "Which constraint matters most?" }] } } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(ledger.get(dispatch.work_id)?.state, "interactive")
    assert.equal(client.requests.some((item) => item.method === "thread/archive"), false)
    assert.equal(callbackRecord, null)
    assert.deepEqual(await controller.dispatch(dispatch), accepted)
    assert.equal(client.requests.filter((item) => item.method === "thread/start").length, 1)
    client.emit({ method: "thread/archived", params: { threadId: "thread-discovery-1" } })
    for (let attempt = 0; attempt < 20 && !ledger.get(dispatch.work_id)?.callbackSent;
      attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(callbackRecord?.terminal?.summary, "Interactive discovery task archived.")
    assert.equal(ledger.get(dispatch.work_id)?.callbackSent, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("an interrupted discovery turn remains available for user recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-interrupted-discovery-"))
  const client = new FakeAppServer(); const ledger = new HostLedger(join(directory, "ledger.json"))
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-backend",
    baseBranch: "dev",
  }, () => Promise.resolve())
  const workId = "00000000-0000-4000-8000-000000000021"
  try {
    await controller.start(); await ledger.reserve(workId, "fingerprint", "token", "interactive")
    await ledger.accept(workId, "thread-discovery-1", "turn-discovery-1")
    client.emit({ method: "turn/completed", params: { threadId: "thread-discovery-1",
      turn: { id: "turn-discovery-1", status: "interrupted", items: [] } } })
    for (let attempt = 0; attempt < 20 && ledger.get(workId)?.state !== "interactive";
      attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(ledger.get(workId)?.state, "interactive")
    assert.equal(client.requests.some((item) => item.method === "thread/archive"), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
