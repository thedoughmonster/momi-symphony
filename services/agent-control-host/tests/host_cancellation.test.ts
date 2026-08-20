import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { HostController } from "../src/host_controller.ts"
import { HostLedger } from "../src/host_ledger.ts"
import { parseHostCancellation } from "../src/parse_host_cancellation.ts"
import { ReviewCredentialBoundary } from "../src/review_credential_boundary.ts"
import { startHostTask } from "../src/start_host_task.ts"
import type { AppServerClient, HostCancellation, HostDispatch } from "../src/types.ts"

const cancellationResult = (state: "requested" | "already_terminal" = "requested") =>
  ({ cancellation_state: state, review_cancellations: [] })
const reviewCancellationResult = (reviewerDispatchId: string, capabilityToken: string,
  identitiesComplete: boolean, interruptionConfirmed: boolean) => ({
  cancellation_state: "requested" as const,
  review_cancellations: [{ reviewer_dispatch_id: reviewerDispatchId,
    capability_token: capabilityToken, host_state: "canceled" as const,
    identities_complete: identitiesComplete,
    interruption_confirmed: interruptionConfirmed }],
})

class FakeAppServer implements AppServerClient {
  requests: Array<{ method: string; params: unknown }> = []
  private listener: (notification: Record<string, unknown>) => void = () => undefined
  connect(): Promise<void> { return Promise.resolve() }
  onNotification(listener: (notification: Record<string, unknown>) => void): void {
    this.listener = listener
  }
  request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params }); return Promise.resolve({} as T)
  }
  emit(notification: Record<string, unknown>): void { this.listener(notification) }
}

class PausedStartAppServer extends FakeAppServer {
  private releaseStart!: () => void
  private markStartReached!: () => void
  readonly startReached = new Promise<void>((resolve) => { this.markStartReached = resolve })
  private readonly startGate = new Promise<void>((resolve) => { this.releaseStart = resolve })
  release(): void { this.releaseStart() }
  override async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === "thread/start") {
      this.markStartReached(); await this.startGate
      return { thread: { id: "thread-late" } } as T
    }
    if (method === "turn/start") return { turn: { id: "turn-late" } } as T
    return {} as T
  }
}

class PausedInterruptAppServer extends FakeAppServer {
  private releaseInterrupt!: () => void
  private markInterruptReached!: () => void
  readonly interruptReached = new Promise<void>((resolve) => {
    this.markInterruptReached = resolve
  })
  private readonly interruptGate = new Promise<void>((resolve) => {
    this.releaseInterrupt = resolve
  })
  release(): void { this.releaseInterrupt() }
  override async request<T>(method: string, params: unknown): Promise<T> {
    if (method !== "turn/interrupt") return super.request(method, params)
    this.requests.push({ method, params }); this.markInterruptReached()
    await this.interruptGate; return {} as T
  }
}

function pausedReviewResponseLoss(mode: "no_id" | "thread_only" | "exact_id") {
  let release!: () => void
  let reached!: () => void
  const startReached = new Promise<void>((resolve) => { reached = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const taskStarter: typeof startHostTask = async (...args) => {
    const observer = args[4] ?? {}
    if (mode !== "no_id") await observer.threadStarted?.(`${mode}-thread`)
    if (mode === "exact_id") {
      await observer.turnStarted?.(`${mode}-thread`, `${mode}-turn`)
    }
    reached(); await gate
    throw new Error("host_start_ambiguous")
  }
  return { taskStarter, startReached, release }
}

function pausedExactReviewSuccess() {
  let release!: () => void
  let reached!: () => void
  const startReached = new Promise<void>((resolve) => { reached = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const taskStarter: typeof startHostTask = async (...args) => {
    const observer = args[4] ?? {}
    await observer.threadStarted?.("start-wins-thread")
    await observer.turnStarted?.("start-wins-thread", "start-wins-turn")
    reached(); await gate
    return { thread_id: "start-wins-thread", turn_id: "start-wins-turn" }
  }
  return { taskStarter, startReached, release }
}

function reviewDispatch(workId: string): HostDispatch {
  return { schema_version: 4, work_id: workId,
    capability_token: "00000000-0000-4000-8000-000000000061",
    issue_id: "00000000-0000-4000-8000-000000000062", issue_identifier: "MOX-260",
    issue_url: "https://linear.app/x/issue/MOX-260/x",
    project_id: "00000000-0000-4000-8000-000000000063",
    project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
    base_branch: "main", active_states: ["In Progress"], interaction_mode: "one_shot",
    thread_name: "MOX-260 · independent review", runtime_role: "independent_reviewer",
    review_workspace_id: "00000000-0000-4000-8000-000000000064",
    stable_instruction: "review", volatile_context: "bounded",
    stable_prefix_fingerprint: "fnv1a64:1111111111111111",
    context_fingerprint: "fnv1a64:2222222222222222",
    policy_version: "independent-review-v1",
    budget: { model_turns: 16, no_progress_cycles: 2, subagents: 0,
      subagent_depth: 0, model_visible_tool_bytes: 96_000, elapsed_ms: 3_600_000 },
    review_subject: { implementation_dispatch_id:
      "00000000-0000-4000-8000-000000000065", pull_request_number: 16,
      head_sha: "a".repeat(40), base_sha: "b".repeat(40), generation: 1,
      profile: "high", model: "gpt-5.6-sol", reasoning_effort: "high",
      budget_fingerprint: "fnv1a64:0b9ef0157af3f30a",
      policy_version: "independent-review-v1" } }
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
    assert.deepEqual(await controller.cancel(input), cancellationResult())
    assert.deepEqual(await controller.cancel(input), cancellationResult())
    assert.equal(client.requests.filter((item) => item.method === "turn/interrupt").length, 1)
    await assert.rejects(controller.cancel({ ...input,
      target_work_ids: ["00000000-0000-4000-8000-000000000009"] }),
    /host_idempotency_conflict/)
    await ledger.terminal(target, { readiness_result: "ready",
      terminal_disposition: "interrupted", summary: "Cancelled." }, new Date().toISOString())
    assert.deepEqual(await controller.cancel({ ...input,
      work_id: "00000000-0000-4000-8000-000000000004" }),
    cancellationResult("already_terminal"))
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
    assert.deepEqual(await controller.cancel(input), cancellationResult())
    assert.deepEqual(await controller.cancel(input), cancellationResult())
    assert.equal(client.requests.filter((item) => item.method === "turn/interrupt").length, 2)
    assert.deepEqual(targets.map((target) => Boolean(ledger.get(target)?.cancellationRequestedAt)),
      [true, true])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("reserved work is durably fenced and interrupted immediately after its turn starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-agent-cancel-reserved-"))
  const ledger = new HostLedger(join(directory, "ledger.json"))
  const client = new PausedStartAppServer()
  const controller = new HostController(client, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, () => Promise.resolve())
  const target = "00000000-0000-4000-8000-000000000041"
  const input: HostCancellation = { schema_version: 2,
    work_id: "00000000-0000-4000-8000-000000000042",
    capability_token: "00000000-0000-4000-8000-000000000043",
    target_work_ids: [target], repository: "thedoughmonster/momi-symphony",
    base_branch: "main" }
  const dispatch: HostDispatch = { schema_version: 3, work_id: target,
    capability_token: "00000000-0000-4000-8000-000000000044",
    issue_id: "00000000-0000-4000-8000-000000000045", issue_identifier: "MOX-260",
    issue_url: "https://linear.app/x/issue/MOX-260/x",
    project_id: "00000000-0000-4000-8000-000000000046",
    project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
    base_branch: "main", active_states: ["In Progress"], interaction_mode: "one_shot",
    thread_name: "MOX-260", stable_instruction: "implement", volatile_context: "bounded",
    stable_prefix_fingerprint: "fnv1a64:1111111111111111",
    context_fingerprint: "fnv1a64:2222222222222222", policy_version: "test-v1",
    budget: { model_turns: 1, no_progress_cycles: 1, subagents: 0, subagent_depth: 0,
      model_visible_tool_bytes: 1_000, elapsed_ms: 60_000 } }
  try {
    await controller.start()
    const starting = controller.dispatch(dispatch)
    await client.startReached
    assert.deepEqual(await controller.cancel(input), cancellationResult())
    assert.notEqual(ledger.get(target)?.cancellationRequestedAt, null)
    assert.equal(client.requests.some((item) => item.method === "turn/interrupt"), false)
    client.release()
    assert.deepEqual(await starting, { thread_id: "thread-late", turn_id: "turn-late" })
    assert.deepEqual(client.requests.find((item) => item.method === "turn/interrupt"), {
      method: "turn/interrupt", params: { threadId: "thread-late", turnId: "turn-late" } })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("ambiguous reviewer cancellation interrupts exact starts and retires response loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-review-cancel-ambiguous-"))
  const ledgerPath = join(directory, "ledger.json")
  const boundary = new ReviewCredentialBoundary(Buffer.alloc(32, 17))
  const ledger = new HostLedger(ledgerPath, boundary)
  const implementationClient = new FakeAppServer(); const reviewClient = new FakeAppServer()
  const controller = new HostController(implementationClient, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, () => Promise.resolve(), reviewClient)
  const unknown = "00000000-0000-4000-8000-000000000051"
  const known = "00000000-0000-4000-8000-000000000052"
  const reviewSubject = { implementation_dispatch_id:
    "00000000-0000-4000-8000-000000000053", pull_request_number: 16,
    head_sha: "a".repeat(40), base_sha: "b".repeat(40), generation: 1,
    profile: "high" as const, model: "gpt-5.6-sol" as const,
    reasoning_effort: "high" as const, budget_fingerprint: "fnv1a64:0b9ef0157af3f30a",
    policy_version: "independent-review-v1" }
  const reserve = (workId: string) => ledger.reserve(workId, `fingerprint-${workId}`,
    `token-${workId}`, "one_shot", { runtime_role: "independent_reviewer",
      review_subject: reviewSubject, review_workspace_id: workId })
  try {
    await controller.start()
    await reserve(unknown); await ledger.threadStarted(unknown, "response-loss-thread")
    await reserve(known); await ledger.turnStarted(known, "known-thread", "known-turn")
    const common = { schema_version: 2 as const,
      capability_token: "00000000-0000-4000-8000-000000000054",
      repository: "thedoughmonster/momi-symphony", base_branch: "main" }
    assert.deepEqual(await controller.cancel({ ...common,
      work_id: "00000000-0000-4000-8000-000000000055", target_work_ids: [unknown] }),
    reviewCancellationResult(unknown, `token-${unknown}`, false, false))
    assert.equal(ledger.get(unknown)?.state, "canceled")
    assert.notEqual(ledger.get(unknown)?.cancellationRequestedAt, null)
    assert.equal(ledger.activeWorkIds().includes(unknown), false)
    const restarted = new HostLedger(ledgerPath, boundary); await restarted.load()
    assert.equal(restarted.get(unknown)?.state, "canceled")
    assert.equal(restarted.activeWorkIds().includes(unknown), false)
    assert.equal(restarted.recoverable().some((record) => record.workId === unknown), false)
    assert.deepEqual(await controller.cancel({ ...common,
      work_id: "00000000-0000-4000-8000-000000000056", target_work_ids: [known] }),
    reviewCancellationResult(known, `token-${known}`, true, true))
    assert.deepEqual(reviewClient.requests.filter((item) => item.method === "turn/interrupt"),
      [{ method: "turn/interrupt", params: { threadId: "known-thread", turnId: "known-turn" } }])
    assert.equal(implementationClient.requests.some((item) => item.method === "turn/interrupt"),
      false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("cancellation remains monotonic across reviewer start response-loss races", async () => {
  const cases = ["no_id", "thread_only", "exact_id"] as const
  for (const [index, mode] of cases.entries()) {
    const directory = await mkdtemp(join(tmpdir(), `momi-review-cancel-race-${mode}-`))
    const ledgerPath = join(directory, "ledger.json")
    const boundary = new ReviewCredentialBoundary(Buffer.alloc(32, 20 + index))
    const ledger = new HostLedger(ledgerPath, boundary)
    const implementationClient = new FakeAppServer(); const reviewClient = new FakeAppServer()
    const paused = pausedReviewResponseLoss(mode)
    const controller = new HostController(implementationClient, ledger, {
      workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
      baseBranch: "main",
    }, () => Promise.resolve(), reviewClient, paused.taskStarter)
    const target = `00000000-0000-4000-8000-00000000007${index}`
    const cancellation: HostCancellation = { schema_version: 2,
      work_id: `00000000-0000-4000-8000-00000000008${index}`,
      capability_token: "00000000-0000-4000-8000-000000000066",
      target_work_ids: [target], repository: "thedoughmonster/momi-symphony",
      base_branch: "main" }
    try {
      await controller.start()
      const starting = controller.dispatch(reviewDispatch(target))
      await paused.startReached
      assert.deepEqual(await controller.cancel(cancellation), reviewCancellationResult(target,
        reviewDispatch(target).capability_token, mode === "exact_id", mode === "exact_id"))
      assert.equal(ledger.get(target)?.state, "canceled", mode)
      paused.release()
      await assert.rejects(starting, /host_start_ambiguous/)
      const retired = ledger.get(target)
      assert.equal(retired?.state, "canceled", mode)
      assert.equal(retired?.reviewResult, null, mode)
      assert.deepEqual([retired?.threadId, retired?.turnId], mode === "no_id"
        ? [null, null] : mode === "thread_only"
          ? ["thread_only-thread", null] : ["exact_id-thread", "exact_id-turn"], mode)
      assert.equal(ledger.activeWorkIds().includes(target), false, mode)
      assert.equal(ledger.recoverable().some((record) => record.workId === target), false, mode)
      assert.equal(implementationClient.requests.some((item) =>
        item.method === "turn/interrupt"), false, mode)
      const interruptions = reviewClient.requests.filter((item) =>
        item.method === "turn/interrupt")
      assert.equal(interruptions.length, mode === "exact_id" ? 1 : 0, mode)
      if (mode === "exact_id") {
        assert.deepEqual(interruptions[0], { method: "turn/interrupt",
          params: { threadId: "exact_id-thread", turnId: "exact_id-turn" } })
        assert.equal(typeof retired?.interruptionRequestedAt, "string")
        assert.equal((await ledger.accept(target, "exact_id-thread", "exact_id-turn")).state,
          "canceled")
      }
      const restarted = new HostLedger(ledgerPath, boundary); await restarted.load()
      assert.equal(restarted.get(target)?.state, "canceled", mode)
      assert.deepEqual([restarted.get(target)?.threadId, restarted.get(target)?.turnId],
        [retired?.threadId, retired?.turnId], mode)
      assert.equal(restarted.activeWorkIds().includes(target), false, mode)
      assert.equal(restarted.recoverable().some((record) => record.workId === target), false, mode)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test("exact reviewer cancellation fences start-wins before interrupt and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-review-cancel-start-wins-"))
  const ledgerPath = join(directory, "ledger.json")
  const boundary = new ReviewCredentialBoundary(Buffer.alloc(32, 29))
  const ledger = new HostLedger(ledgerPath, boundary)
  const implementationClient = new FakeAppServer()
  const reviewClient = new PausedInterruptAppServer()
  const paused = pausedExactReviewSuccess()
  let callbacks = 0
  const controller = new HostController(implementationClient, ledger, {
    workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
    baseBranch: "main",
  }, () => { callbacks += 1; return Promise.resolve() }, reviewClient, paused.taskStarter)
  const target = "00000000-0000-4000-8000-000000000091"
  const cancellation: HostCancellation = { schema_version: 2,
    work_id: "00000000-0000-4000-8000-000000000092",
    capability_token: "00000000-0000-4000-8000-000000000093",
    target_work_ids: [target], repository: "thedoughmonster/momi-symphony",
    base_branch: "main" }
  try {
    await controller.start()
    const starting = controller.dispatch(reviewDispatch(target))
    await paused.startReached
    const canceling = controller.cancel(cancellation)
    await reviewClient.interruptReached
    const fenced = ledger.get(target)
    assert.equal(fenced?.state, "canceled")
    assert.equal(typeof fenced?.cancellationRequestedAt, "string")
    assert.equal(typeof fenced?.interruptionRequestedAt, "string")
    assert.equal(fenced?.interruptionConfirmedAt, null)
    assert.equal(ledger.activeWorkIds().includes(target), false)
    assert.equal(ledger.recoverable().some((record) => record.workId === target), false)

    paused.release()
    assert.deepEqual(await starting,
      { thread_id: "start-wins-thread", turn_id: "start-wins-turn" })
    assert.equal(ledger.get(target)?.state, "canceled")
    reviewClient.emit({ method: "turn/completed", params: {
      threadId: "start-wins-thread", turn: { id: "start-wins-turn", status: "completed",
        items: [{ type: "agentMessage", text: JSON.stringify({ result: "accepted",
          findings: [], artifact_ref: "review://canceled/start-wins" }) }] } } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(callbacks, 0)
    assert.equal(ledger.get(target)?.reviewResult, null)
    assert.equal(ledger.get(target)?.terminal, null)

    const restartedLedger = new HostLedger(ledgerPath, boundary)
    const restartedReviewClient = new FakeAppServer()
    const restarted = new HostController(new FakeAppServer(), restartedLedger, {
      workspaceRoot: "/workspace", repository: "thedoughmonster/momi-symphony",
      baseBranch: "main",
    }, () => { callbacks += 1; return Promise.resolve() }, restartedReviewClient)
    await restarted.start()
    assert.deepEqual(restartedReviewClient.requests.filter((item) =>
      item.method === "turn/interrupt"), [{ method: "turn/interrupt",
      params: { threadId: "start-wins-thread", turnId: "start-wins-turn" } }])
    assert.equal(typeof restartedLedger.get(target)?.interruptionConfirmedAt, "string")
    assert.equal(restartedLedger.activeWorkIds().includes(target), false)
    assert.equal(restartedLedger.recoverable().some((record) => record.workId === target), false)
    assert.deepEqual(await restarted.cancel(cancellation), reviewCancellationResult(target,
      reviewDispatch(target).capability_token, true, true))

    reviewClient.release(); assert.deepEqual(await canceling, reviewCancellationResult(target,
      reviewDispatch(target).capability_token, true, true))
    assert.equal(callbacks, 0)
    assert.equal(implementationClient.requests.some((item) =>
      item.method === "turn/interrupt"), false)
    const finalLedger = new HostLedger(ledgerPath, boundary); await finalLedger.load()
    assert.equal(finalLedger.get(target)?.state, "canceled")
    assert.equal(typeof finalLedger.get(target)?.interruptionConfirmedAt, "string")
    assert.equal(finalLedger.activeWorkIds().includes(target), false)
    assert.equal(finalLedger.recoverable().some((record) => record.workId === target), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
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
    assert.deepEqual(await controller.cancel(input), cancellationResult())
    assert.equal(client.requests.filter((item) => item.method === "thread/archive").length, 1)
    assert.equal(ledger.get(target)?.state, "terminal")
    assert.notEqual(ledger.get(target)?.cancellationRequestedAt, null)
    assert.equal(ledger.get(target)?.callbackSent, true)
    assert.equal(callbacks, 1)
    assert.deepEqual(await controller.cancel(input), cancellationResult())
    assert.equal(client.requests.filter((item) => item.method === "thread/archive").length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
