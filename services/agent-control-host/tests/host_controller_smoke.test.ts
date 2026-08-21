import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HostController } from "../src/host_controller.ts"
import { HostLedger } from "../src/host_ledger.ts"
import { ReviewCredentialBoundary } from "../src/review_credential_boundary.ts"
import type { AppServerClient, HostDispatch, HostRecord } from "../src/types.ts"

class FakeAppServer implements AppServerClient {
  requests: Array<{ method: string; params: unknown }> = []
  resumeTurns: Array<Record<string, unknown>> = []
  resumeFailures = 0
  completeBeforeTurnStartResponse = false
  listener: (notification: Record<string, unknown>) => void = () => undefined
  async connect(): Promise<void> {}
  onNotification(listener: (notification: Record<string, unknown>) => void): void {
    this.listener = listener
  }
  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === "thread/start") return { thread: { id: "thread-visible-1" } } as T
    if (method === "turn/start") {
      if (this.completeBeforeTurnStartResponse) this.emit({ method: "turn/completed",
        params: { threadId: "thread-visible-1", turn: this.resumeTurns[0] } })
      return { turn: { id: "turn-visible-1" } } as T
    }
    if (method === "thread/resume") {
      if (this.resumeFailures > 0) {
        this.resumeFailures -= 1; throw new Error("resume_failed")
      }
      return { thread: { turns: this.resumeTurns } } as T
    }
    if (method === "thread/read") return { thread: { turns: this.resumeTurns } } as T
    return {} as T
  }
  emit(notification: Record<string, unknown>): void { this.listener(notification) }
}

test("review start ledger releases definite prestart work and fences ambiguous identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-control-start-"))
  const ledger = new HostLedger(join(directory, "ledger.json"))
  try {
    await ledger.reserve("prestart", "fingerprint", "token")
    await ledger.releaseReserved("prestart")
    assert.equal(ledger.get("prestart"), null)
    await ledger.reserve("ambiguous", "fingerprint", "token")
    await ledger.threadStarted("ambiguous", "thread-known")
    await ledger.releaseReserved("ambiguous")
    assert.equal(ledger.get("ambiguous")?.state, "ambiguous")
    assert.equal(ledger.get("ambiguous")?.threadId, "thread-known")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("thread-only ambiguous review start is missing unless its turn is recoverable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-review-status-"))
  const implementationClient = new FakeAppServer()
  const reviewClient = new FakeAppServer()
  const ledger = new HostLedger(join(directory, "ledger.json"),
    new ReviewCredentialBoundary(Buffer.alloc(32, 7)))
  const controller = new HostController(implementationClient, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, async () => undefined, reviewClient)
  const reviewWork = "00000000-0000-4000-8000-000000000021"
  try {
    await ledger.reserve(reviewWork, "fingerprint", "token", "one_shot", {
      runtime_role: "independent_reviewer", review_subject: {
        implementation_dispatch_id: "00000000-0000-4000-8000-000000000022",
        pull_request_number: 16, head_sha: "a".repeat(40), base_sha: "b".repeat(40),
        profile: "high", policy_version: "independent-review-v1" },
      review_workspace_id: reviewWork })
    await ledger.threadStarted(reviewWork, "review-thread")
    assert.deepEqual(await controller.reviewWorkState(reviewWork),
      { review_work_state: "missing" })
    reviewClient.resumeTurns = [{ id: "review-turn", status: "inProgress", items: [] }]
    assert.deepEqual(await controller.reviewWorkState(reviewWork),
      { review_work_state: "running" })
    assert.equal(ledger.get(reviewWork)?.turnId, "review-turn")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("one canonical dispatch creates one App Server task and archives it once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-control-"))
  const client = new FakeAppServer()
  let callbackRecord: HostRecord | null = null
  let callbackResolve: (() => void) | null = null
  const callbackDone = new Promise<void>((resolve) => { callbackResolve = resolve })
  const ledger = new HostLedger(join(directory, "ledger.json"))
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, async (record) => { callbackRecord = record; callbackResolve?.() })
  const dispatch: HostDispatch = { schema_version: 1,
    interaction_mode: "one_shot", thread_name: "MOX-151 · execute-run",
    work_id: "00000000-0000-4000-8000-000000000001",
    capability_token: "00000000-0000-4000-8000-000000000002",
    issue_id: "00000000-0000-4000-8000-000000000003", issue_identifier: "MOX-151",
    issue_url: "https://linear.app/x/issue/MOX-151/x",
    project_id: "00000000-0000-4000-8000-000000000004",
    project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
    base_branch: "main", active_states: ["Todo"],
    instruction: "Execute MOX-151 directly after a fresh bounded readiness preflight." }
  try {
    await controller.start()
    assert.deepEqual(await controller.dispatch(dispatch),
      { thread_id: "thread-visible-1", turn_id: "turn-visible-1" })
    const turnStart = client.requests.find((request) => request.method === "turn/start")
    assert.equal((turnStart?.params as Record<string, unknown>).approvalPolicy, "never")
    assert.deepEqual((turnStart?.params as Record<string, unknown>).sandboxPolicy,
      { type: "dangerFullAccess" })
    const replay = { ...dispatch,
      capability_token: "00000000-0000-4000-8000-000000000009" }
    await ledger.ambiguous(dispatch.work_id)
    assert.deepEqual(await controller.dispatch(replay),
      { thread_id: "thread-visible-1", turn_id: "turn-visible-1" })
    assert.equal(client.requests.filter((request) => request.method === "thread/start").length, 1)
    client.emit({ method: "turn/completed", params: { threadId: "thread-visible-1",
      turn: { id: "turn-visible-1", status: "completed", items: [{ type: "agentMessage",
        text: JSON.stringify({ readiness_result: "unready", disposition: "completed",
          summary: "Issue is blocked; remove the blocker before execution." }) }] } } })
    await callbackDone
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(client.requests.filter((request) => request.method === "thread/archive").length, 1)
    assert.equal(callbackRecord?.state, "terminal")
    assert.equal(callbackRecord?.terminal?.readiness_result, "unready")
    assert.equal(callbackRecord?.capabilityToken, replay.capability_token)
    assert.equal(ledger.get(dispatch.work_id)?.callbackSent, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("replay recovers a raced terminal notification after resume failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-control-race-"))
  const client = new FakeAppServer()
  client.completeBeforeTurnStartResponse = true
  client.resumeFailures = 1
  client.resumeTurns = [{ id: "turn-visible-1", status: "interrupted", items: [] }]
  const ledger = new HostLedger(join(directory, "ledger.json"))
  let callbackRecord: HostRecord | null = null
  let callbackResolve: (() => void) | null = null
  const callbackDone = new Promise<void>((resolve) => { callbackResolve = resolve })
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, async (record) => { callbackRecord = record; callbackResolve?.() })
  const dispatch: HostDispatch = { schema_version: 1,
    interaction_mode: "one_shot", thread_name: "MOX-154 · execute-run",
    work_id: "00000000-0000-4000-8000-000000000011",
    capability_token: "00000000-0000-4000-8000-000000000012",
    issue_id: "00000000-0000-4000-8000-000000000013", issue_identifier: "MOX-154",
    issue_url: "https://linear.app/x/issue/MOX-154/x",
    project_id: "00000000-0000-4000-8000-000000000014",
    project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
    base_branch: "main", active_states: ["Todo"],
    instruction: "Execute MOX-154 directly after a fresh bounded readiness preflight." }
  try {
    await controller.start(); await controller.dispatch(dispatch)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(ledger.get(dispatch.work_id)?.state, "accepted")
    assert.equal(callbackRecord, null)
    await ledger.ambiguous(dispatch.work_id)
    const restartedClient = new FakeAppServer()
    restartedClient.resumeTurns = client.resumeTurns
    const restartedLedger = new HostLedger(join(directory, "ledger.json"))
    const restarted = new HostController(restartedClient, restartedLedger, {
      workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
      baseBranch: "main",
    }, async (record) => { callbackRecord = record; callbackResolve?.() })
    await restarted.start()
    await callbackDone
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(callbackRecord?.terminal?.terminal_disposition, "interrupted")
    assert.equal(restartedLedger.get(dispatch.work_id)?.callbackSent, true)
    assert.equal(restartedClient.requests.filter(
      (request) => request.method === "thread/archive").length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
