import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { extractReviewResult } from "../src/extract_review_result.ts"
import { HostLedger } from "../src/host_ledger.ts"
import { parseHostDispatch } from "../src/parse_host_dispatch.ts"
import { ReviewCredentialBoundary } from "../src/review_credential_boundary.ts"
import { startHostTask } from "../src/start_host_task.ts"
import type { AppServerClient, HostDispatch } from "../src/types.ts"

const dispatch: HostDispatch = { schema_version: 4,
  work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002",
  issue_id: "00000000-0000-4000-8000-000000000003", issue_identifier: "MOX-260",
  issue_url: "https://linear.app/x/issue/MOX-260/x",
  project_id: "00000000-0000-4000-8000-000000000004",
  project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
  base_branch: "main", active_states: ["In Progress"], interaction_mode: "one_shot",
  thread_name: "MOX-260 · independent review", runtime_role: "independent_reviewer",
  review_workspace_id: "00000000-0000-4000-8000-000000000006",
  stable_instruction: "Perform read-only independent semantic review of the exact subject only.",
  volatile_context: "Review mode: host_attested\nExact bounded packet with repository, PR, revisions, rules, and diff evidence.",
  stable_prefix_fingerprint: "fnv1a64:1111111111111111",
  context_fingerprint: "fnv1a64:2222222222222222",
  policy_version: "independent-review-v1", budget: { model_turns: 8,
    no_progress_cycles: 2, subagents: 0, subagent_depth: 0,
    model_visible_tool_bytes: 48_000, elapsed_ms: 1_800_000 },
  review_subject: { implementation_dispatch_id: "00000000-0000-4000-8000-000000000005",
    pull_request_number: 16, head_sha: "a".repeat(40), base_sha: "b".repeat(40),
    generation: 1, profile: "high", policy_version: "independent-review-v1" } }

test("v4 review dispatch is strictly role-attested and starts a fresh typed turn", async () => {
  assert.deepEqual(parseHostDispatch(dispatch), dispatch)
  assert.equal(parseHostDispatch({ ...dispatch, runtime_role: "implementation" }), null)
  assert.equal(parseHostDispatch({ ...dispatch, review_subject: {
    ...dispatch.review_subject!, policy_version: "wrong" } }), null)
  const requests: Array<{ method: string; params: unknown }> = []
  const client = { connect: async () => undefined, onNotification: () => undefined,
    request: async <T>(method: string, params: unknown): Promise<T> => {
      requests.push({ method, params })
      return (method === "thread/start" ? { thread: { id: "fresh-review-thread" } }
        : method === "turn/start" ? { turn: { id: "fresh-review-turn" } } : {}) as T
    } } as AppServerClient
  await startHostTask(client, { workspaceRoot: "/workspace",
    repository: dispatch.repository, baseBranch: "main" }, dispatch,
  async () => "/isolated-review")
  const params = requests.find((request) => request.method === "turn/start")
    ?.params as Record<string, unknown>
  assert.equal((params.responsesapiClientMetadata as Record<string, unknown>).runtime_role,
    "independent_reviewer")
  assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false })
  assert.deepEqual(params.runtimeWorkspaceRoots, ["/isolated-review"])
  assert.equal(requests.find((request) => request.method === "thread/start")
    ?.params && (requests.find((request) => request.method === "thread/start")
      ?.params as Record<string, unknown>).cwd, "/isolated-review")
  assert.deepEqual((params.outputSchema as Record<string, unknown>).required,
    ["result", "findings", "artifact_ref"])
})

test("bounded correction reuses only the prior reviewer thread with a fresh turn", async () => {
  const requests: Array<{ method: string; params: unknown }> = []
  const client = { connect: async () => undefined, onNotification: () => undefined,
    request: async <T>(method: string, params: unknown): Promise<T> => {
      requests.push({ method, params })
      return (method === "turn/start" ? { turn: { id: "reverification-turn" } } : {}) as T
    } } as AppServerClient
  const reverification = { ...dispatch, review_thread_id: "prior-review-thread",
    review_subject: { ...dispatch.review_subject!, generation: 2 } }
  assert.deepEqual(parseHostDispatch(reverification), reverification)
  assert.deepEqual(await startHostTask(client, { workspaceRoot: "/workspace",
    repository: dispatch.repository, baseBranch: "main" }, reverification,
  async () => "/isolated-review"),
  { thread_id: "prior-review-thread", turn_id: "reverification-turn" })
  assert.equal(requests.some((request) => request.method === "thread/start"), false)
  assert.deepEqual(requests[0], { method: "thread/unarchive",
    params: { threadId: "prior-review-thread" } })
  const metadata = (requests.find((request) => request.method === "turn/start")?.params as {
    responsesapiClientMetadata: Record<string, unknown> }).responsesapiClientMetadata
  assert.equal(metadata.review_mode, "bounded_reverification")
  const turnInput = (requests.find((request) => request.method === "turn/start")?.params as {
    input: Array<{ text: string }> }).input
  assert.equal(turnInput[2]?.text, "Host-attested review mode: bounded_reverification.")
})

test("unavailable prior reviewer starts a fresh isolated recovery thread", async () => {
  const requests: Array<{ method: string; params: unknown }> = []
  const client = { connect: async () => undefined, onNotification: () => undefined,
    request: async <T>(method: string, params: unknown): Promise<T> => {
      requests.push({ method, params })
      if (method === "thread/unarchive") throw new Error("reviewer unavailable")
      if (method === "thread/start") return { thread: { id: "recovery-thread" } } as T
      if (method === "turn/start") return { turn: { id: "recovery-turn" } } as T
      return {} as T
    } } as AppServerClient
  const result = await startHostTask(client, { workspaceRoot: "/workspace",
    repository: dispatch.repository, baseBranch: "main" },
  { ...dispatch, review_thread_id: "unavailable-thread" }, async () => "/isolated-review")
  assert.deepEqual(result, { thread_id: "recovery-thread", turn_id: "recovery-turn" })
  assert.deepEqual(requests.map((request) => request.method),
    ["thread/unarchive", "thread/start", "thread/name/set", "turn/start"])
  const turn = requests.at(-1)?.params as { input: Array<{ text: string }>;
    responsesapiClientMetadata: Record<string, unknown> }
  assert.equal(turn.input[2]?.text, "Host-attested review mode: fresh_recovery.")
  assert.equal(turn.responsesapiClientMetadata.review_mode, "fresh_recovery")
  assert.match(turn.input[1]?.text ?? "", /^Review mode: fresh_recovery/m)
  assert.doesNotMatch(turn.input[1]?.text ?? "", /Review mode: bounded_reverification/)
})

test("review start reports ambiguity only after persisting observed runtime identities", async () => {
  const observed: string[] = []
  const client = { connect: async () => undefined, onNotification: () => undefined,
    request: async <T>(method: string): Promise<T> => {
      if (method === "thread/start") return { thread: { id: "observed-thread" } } as T
      if (method === "turn/start") throw new Error("connection lost")
      return {} as T
    } } as AppServerClient
  await assert.rejects(() => startHostTask(client, { workspaceRoot: "/workspace",
    repository: dispatch.repository, baseBranch: "main" }, dispatch,
  async () => "/isolated-review", { threadStarted: async (threadId) => {
    observed.push(threadId)
  } }), /host_start_ambiguous/)
  assert.deepEqual(observed, ["observed-thread"])
})

test("review start preserves definite prestart refusal for safe retry", async () => {
  const client = { connect: async () => undefined, onNotification: () => undefined,
    request: async <T>(method: string): Promise<T> => {
      if (method === "thread/start") throw new Error("codex_proxy_not_connected")
      return {} as T
    } } as AppServerClient
  await assert.rejects(() => startHostTask(client, { workspaceRoot: "/workspace",
    repository: dispatch.repository, baseBranch: "main" }, dispatch,
  async () => "/isolated-review"), /codex_proxy_not_connected/)
})

test("review result validation computes provenance and rejects blocking acceptance", () => {
  const accepted = extractReviewResult({ id: "turn", status: "completed", items: [{
    type: "agentMessage", text: JSON.stringify({ result: "accepted", findings: [],
      artifact_ref: "review://attempt/1" }) }] })
  assert.equal(accepted?.result, "accepted")
  assert.match(accepted?.result_fingerprint ?? "", /^sha256:[0-9a-f]{64}$/)
  const finding = { id: "finding-1", severity: "blocking", category: "correctness",
    path: "src/a.ts", line: 1, contract: "must fail closed",
    required_outcome: "reject stale evidence", evidence: "stale evidence passes" }
  assert.equal(extractReviewResult({ id: "turn", status: "completed", items: [{
    type: "agentMessage", text: JSON.stringify({ result: "accepted", findings: [finding],
      artifact_ref: "review://attempt/2" }) }] }), null)
  assert.equal(extractReviewResult({ id: "turn", status: "completed", items: [{
    type: "agentMessage", text: JSON.stringify({ result: "changes_requested",
      findings: [finding], artifact_ref: "review://attempt/3", transcript: "forbidden" }) }] }), null)
  assert.equal(extractReviewResult({ id: "turn", status: "completed", items: [{
    type: "agentMessage", text: JSON.stringify({ result: "changes_requested",
      findings: [{ ...finding, path: "src\\a.ts" }],
      artifact_ref: "review://attempt/4" }) }] }), null)
})

test("full-access implementation execution cannot obtain sealed reviewer credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "momi-review-credential-boundary-"))
  const ledgerPath = join(directory, "ledger.json")
  const capabilityToken = "reviewer-capability-not-readable"
  const threadId = "reviewer-thread-not-readable"
  const turnId = "reviewer-turn-not-readable"
  try {
    await assert.rejects(new HostLedger(join(directory, "unsealed-ledger.json"))
      .reserve(dispatch.work_id, "review-fingerprint", capabilityToken, "one_shot", {
        runtime_role: "independent_reviewer", review_subject: dispatch.review_subject,
      }), /review_credential_boundary_required/)
    const ledger = new HostLedger(ledgerPath,
      new ReviewCredentialBoundary(Buffer.alloc(32, 11)))
    await ledger.reserve(dispatch.work_id, "review-fingerprint", capabilityToken,
      "one_shot", { runtime_role: "independent_reviewer",
        review_subject: dispatch.review_subject,
        review_workspace_id: dispatch.review_workspace_id })
    await ledger.accept(dispatch.work_id, threadId, turnId)

    let implementationRead = ""
    const implementationRequests: Array<{ method: string; params: unknown }> = []
    const implementationClient = { connect: async () => undefined,
      onNotification: () => undefined,
      request: async <T>(method: string, params: unknown): Promise<T> => {
        implementationRequests.push({ method, params })
        if (method === "turn/start") implementationRead = await readFile(ledgerPath, "utf8")
        return (method === "thread/start" ? { thread: { id: "implementation-thread" } }
          : method === "turn/start" ? { turn: { id: "implementation-turn" } } : {}) as T
      } } as AppServerClient
    const implementation = { ...dispatch, schema_version: 3 as const,
      runtime_role: undefined, review_subject: undefined, review_workspace_id: undefined,
      work_id: "00000000-0000-4000-8000-000000000010",
      capability_token: "implementation-capability", thread_name: "MOX-260 · execute-run" }
    await startHostTask(implementationClient, { workspaceRoot: "/workspace",
      repository: dispatch.repository, baseBranch: "main" }, implementation)

    const turn = implementationRequests.find((request) => request.method === "turn/start")
      ?.params as Record<string, unknown>
    assert.deepEqual(turn.sandboxPolicy, { type: "dangerFullAccess" })
    for (const credential of [capabilityToken, threadId, turnId,
      dispatch.review_subject!.implementation_dispatch_id,
      dispatch.review_subject!.head_sha, dispatch.review_subject!.base_sha]) {
      assert.equal(implementationRead.includes(credential), false)
      assert.equal(JSON.stringify(turn).includes(credential), false)
    }
    const stored = JSON.parse(implementationRead).records[0] as Record<string, unknown>
    assert.equal("capabilityToken" in stored, false)
    assert.equal("threadId" in stored, false)
    assert.equal("turnId" in stored, false)
    assert.equal("reviewSubject" in stored, false)
    assert.equal(typeof stored.sealedReviewCredentials, "object")
    const restartedLedger = new HostLedger(ledgerPath,
      new ReviewCredentialBoundary(Buffer.alloc(32, 11)))
    await restartedLedger.load()
    assert.equal(restartedLedger.get(dispatch.work_id)?.capabilityToken, capabilityToken)
    assert.equal(restartedLedger.get(dispatch.work_id)?.threadId, threadId)
    assert.equal(restartedLedger.get(dispatch.work_id)?.turnId, turnId)
    assert.deepEqual(restartedLedger.get(dispatch.work_id)?.reviewSubject,
      dispatch.review_subject)
    const unit = await readFile(new URL("../../../ops/systemd/momi-agent-control-host.service",
      import.meta.url), "utf8")
    assert.match(unit, /^User=momi-agent-control$/m)
    assert.match(unit,
      /^LoadCredential=momi-review-ledger-key:\/etc\/momi-agent-control\/review-ledger-key$/m)
    assert.match(unit, /^StateDirectory=momi-agent-control$/m)
    assert.match(unit, /^UMask=0077$/m)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
