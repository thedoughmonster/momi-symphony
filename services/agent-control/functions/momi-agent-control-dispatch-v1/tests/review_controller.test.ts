import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import type { Sql } from "postgres"

import { reviewBudgetFingerprint, REVIEW_CHECK_NAME, REVIEW_POLICY_VERSION } from
  "../../../src/independent_review.ts"
import { stableFingerprint } from "../../../src/execution_efficiency.ts"
import { processMergePreflight, processReviewStatus, processReviewTerminal,
  promoteReviewProfile } from "../src/review_controller.ts"
import type { MergePreflightInput, ReviewStatusInput, ReviewTerminalInput } from "../src/types.ts"

const implementationId = "00000000-0000-4000-8000-000000000001"
const reviewerId = "00000000-0000-4000-8000-000000000002"
const reviewAttemptId = "00000000-0000-4000-8000-000000000003"
const token = "00000000-0000-4000-8000-000000000004"
const repository = "thedoughmonster/momi-symphony"
const head = "a".repeat(40); const base = "b".repeat(40)
const outputSchema = JSON.parse(await readFile(new URL(
  "../contracts/output.schema.json", import.meta.url), "utf8")) as Record<string, unknown>

function assertOutput(value: unknown): void {
  assert.equal(matchesSchema(outputSchema, value, outputSchema), true,
    `output contract rejected ${JSON.stringify(value)}`)
}

function matchesSchema(schema: unknown, value: unknown,
  root: Record<string, unknown>): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false
  const rule = schema as Record<string, unknown>
  if (typeof rule.$ref === "string") {
    const target = rule.$ref.split("/").slice(1).reduce<unknown>((current, part) =>
      current && typeof current === "object"
        ? (current as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")]
        : undefined, root)
    return matchesSchema(target, value, root)
  }
  if (Array.isArray(rule.anyOf) && !rule.anyOf.some((entry) => matchesSchema(entry, value, root))) {
    return false
  }
  if ("const" in rule && !Object.is(rule.const, value)) return false
  if (Array.isArray(rule.enum) && !rule.enum.some((entry) => Object.is(entry, value))) return false
  if (rule.type !== undefined && !matchesType(rule.type, value)) return false
  if (typeof value === "string") {
    if (typeof rule.minLength === "number" && value.length < rule.minLength) return false
    if (typeof rule.maxLength === "number" && value.length > rule.maxLength) return false
    if (typeof rule.pattern === "string" && !new RegExp(rule.pattern).test(value)) return false
    if (rule.format === "uuid" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(value)) return false
  }
  if (typeof value === "number" && typeof rule.minimum === "number" &&
    value < rule.minimum) return false
  if (Array.isArray(value)) {
    if (typeof rule.maxItems === "number" && value.length > rule.maxItems) return false
    if (rule.items !== undefined && value.some((entry) =>
      !matchesSchema(rule.items, entry, root))) return false
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    const properties = rule.properties && typeof rule.properties === "object"
      ? rule.properties as Record<string, unknown> : {}
    if (Array.isArray(rule.required) && rule.required.some((key) =>
      typeof key !== "string" || !Object.hasOwn(object, key))) return false
    if (rule.additionalProperties === false && Object.keys(object).some((key) =>
      !Object.hasOwn(properties, key))) return false
    for (const [key, entry] of Object.entries(object)) {
      if (properties[key] !== undefined && !matchesSchema(properties[key], entry, root)) return false
    }
  }
  return true
}

function matchesType(type: unknown, value: unknown): boolean {
  const types = Array.isArray(type) ? type : [type]
  return types.some((candidate) => candidate === "null" ? value === null
    : candidate === "array" ? Array.isArray(value)
    : candidate === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : candidate === "integer" ? Number.isInteger(value)
    : typeof value === candidate)
}

test("accepted review remains unprojected until authenticated merge preflight", async () => {
  const published: boolean[] = []
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?")
    if (query.includes("mapped_repository as repository")) return [{ repository }]
    if (query.includes("record_review_result_v1")) return [{ recorded: true }]
    if (query.includes("select state from")) return [{ state: "accepted" }]
    throw new Error(`unexpected_sql:${query}`)
  }) as unknown as Sql
  ;(sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value
  const input = { event: "review_terminal", reviewer_dispatch_id: reviewerId,
    capability_token: token, runtime_role: "independent_reviewer",
    thread_id: "review-thread", turn_id: "review-turn",
    review_subject: { implementation_dispatch_id: implementationId,
      pull_request_number: 16, head_sha: head, base_sha: base, generation: 1,
      profile: "high", model: "gpt-5.6-sol", reasoning_effort: "high",
      budget_fingerprint: reviewBudgetFingerprint("high"),
      policy_version: REVIEW_POLICY_VERSION },
    review_result: { result: "accepted", findings: [], artifact_ref: "review://exact",
      result_fingerprint: `sha256:${"c".repeat(64)}` }, terminal_disposition: "completed",
    archived_at: "2026-08-20T15:00:00.000Z", telemetry: {} } as ReviewTerminalInput
  const github = { publishReviewCheck: async (_repository: string, _head: string,
    success: boolean) => { published.push(success) } }
  const response = await processReviewTerminal(input, sql, github as never,
    async () => "Running" as never)
  assert.equal(response.disposition, "accepted")
  assertOutput(response)
  assert.deepEqual(published, [])
})

test("review escalation dispatches a fresh promoted reviewer and exhausts at high", async () => {
  assert.equal(promoteReviewProfile("low"), "standard")
  assert.equal(promoteReviewProfile("standard"), "high")
  assert.equal(promoteReviewProfile("high"), null)
  const promotedReviewerId = "00000000-0000-4000-8000-000000000020"
  const promotedToken = "00000000-0000-4000-8000-000000000021"
  const reconciled: string[] = []
  const published: boolean[] = []
  const hostBodies: Array<Record<string, unknown>> = []
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?")
    if (query.includes("mapped_repository as repository")) return [{ repository }]
    if (query.includes("record_review_result_v1")) return [{ recorded: true }]
    if (query.includes("select state from")) return [{ state: "escalated" }]
    if (query.includes("mapping.host_dispatch_url")) return [{
      host_dispatch_url: "https://host.example/v1/dispatch", issue_id: "issue-id",
      issue_identifier: "MOX-260", issue_url: "https://linear.example/MOX-260",
      project_id: "project-id", project_name: "Symphony Control Plane",
      base_branch: "main", active_states: ["In Progress"],
    }]
    if (query.includes("create_escalated_review_attempt_v1")) return [{
      disposition: "created", review_attempt_id: reviewAttemptId,
      reviewer_dispatch_id: promotedReviewerId, reviewer_capability_token: promotedToken,
      generation: 2, profile: "standard",
    }]
    if (query.includes("update momi_agent_ops.review_attempts set")) return []
    if (query.includes("record_reviewer_start_v1")) return [{ recorded: true }]
    throw new Error(`unexpected_sql:${query}`)
  }) as unknown as Sql
  ;(sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value
  const subject = { repository, pullRequestNumber: 16, state: "open" as const,
    baseBranch: "main", headSha: head, baseSha: base,
    changedPaths: ["docs/review.md"], riskDimensions: ["general" as const],
    diffArtifactRef: "github://exact-diff" }
  const github = { loadSubject: async () => subject,
    loadApplicableRules: async (_repository: string, revision: string) => {
      assert.equal(revision, base)
      const content = "Protected governance requires exact substantive review."
      return [{ path: "AGENTS.md", fingerprint: stableFingerprint(content), content }]
    }, loadHeadChecks: async () => [{ name: "CI", conclusion: "success", head_sha: head }],
    publishReviewCheck: async (_repository: string, _head: string, success: boolean) => {
      published.push(success)
    } }
  const input = { event: "review_terminal", reviewer_dispatch_id: reviewerId,
    capability_token: token, runtime_role: "independent_reviewer",
    thread_id: "low-thread", turn_id: "low-turn",
    review_subject: { implementation_dispatch_id: implementationId,
      pull_request_number: 16, head_sha: head, base_sha: base, generation: 1,
      profile: "low", model: "gpt-5.6-luna", reasoning_effort: "low",
      budget_fingerprint: reviewBudgetFingerprint("low"),
      policy_version: REVIEW_POLICY_VERSION },
    review_result: { result: "escalate", findings: [], artifact_ref: "review://low",
      result_fingerprint: `sha256:${"d".repeat(64)}` }, terminal_disposition: "completed",
    archived_at: "2026-08-20T15:00:00.000Z", telemetry: {} } as ReviewTerminalInput
  const originalDeno = (globalThis as Record<string, unknown>).Deno
  ;(globalThis as Record<string, unknown>).Deno = { env: { get: () => "host-secret" } }
  try {
    const result = await processReviewTerminal(input, sql, github as never,
      async (workId) => { reconciled.push(workId); return "Reviewing" as never },
      async (_url, init) => {
        hostBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ thread_id: "standard-thread", turn_id: "standard-turn" })
      }, async () => ({ identifier: "MOX-260", title: "Independent review",
        description: "## Outcome\nRequire independent review.\n## Source decisions",
        state: "In Progress", native_ref: { project_id: "project-id" } } as never))
    assert.equal(result.disposition, "accepted")
    assert.equal(result.profile, "standard")
    assertOutput(result)
    assert.deepEqual(published, [false])
    assert.deepEqual(reconciled, [implementationId])
    assert.equal(hostBodies.length, 1)
    assert.equal((hostBodies[0]?.review_subject as Record<string, unknown>).profile, "standard")
    assert.equal((hostBodies[0]?.review_subject as Record<string, unknown>).model,
      "gpt-5.6-terra")
    assert.equal((hostBodies[0]?.review_subject as Record<string, unknown>).reasoning_effort,
      "medium")
    assert.equal((hostBodies[0]?.review_subject as Record<string, unknown>).budget_fingerprint,
      reviewBudgetFingerprint("standard"))
    assert.match(String(hostBodies[0]?.stable_instruction),
      /Protected governance requires exact substantive review/)
    assert.match(String(hostBodies[0]?.stable_instruction), new RegExp(base))
    assert.equal("review_thread_id" in hostBodies[0]!, false)
    assert.deepEqual((hostBodies[0]?.budget as Record<string, unknown>).model_turns, 8)
  } finally {
    if (originalDeno === undefined) delete (globalThis as Record<string, unknown>).Deno
    else (globalThis as Record<string, unknown>).Deno = originalDeno
  }

  const exhaustedSql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?")
    if (query.includes("mapped_repository as repository")) return [{ repository }]
    if (query.includes("record_review_result_v1")) return [{ recorded: true }]
    if (query.includes("select state from")) return [{ state: "escalated" }]
    if (query.includes("create_escalated_review_attempt_v1")) return [{
      disposition: "escalation_exhausted", review_attempt_id: reviewAttemptId,
      reviewer_dispatch_id: reviewerId, reviewer_capability_token: null,
      generation: 3, profile: "high",
    }]
    throw new Error(`unexpected_sql:${query}`)
  }) as unknown as Sql
  ;(exhaustedSql as unknown as { json: (value: unknown) => unknown }).json = (value) => value
  const exhausted = await processReviewTerminal({ ...input,
    review_subject: { ...input.review_subject, generation: 3, profile: "high",
      model: "gpt-5.6-sol", reasoning_effort: "high",
      budget_fingerprint: reviewBudgetFingerprint("high") } },
  exhaustedSql, github as never, async () => "Failed" as never)
  assert.equal(exhausted.disposition, "escalation_exhausted")
  assertOutput(exhausted)
})

test("strict output contract covers every current review response family", async () => {
  const requestDispositions = ["implementation_identity_refused",
    "focused_validation_required", "already_accepted", "already_running",
    "changes_requested", "reviewer_interruption_pending", "capacity_wait",
    "reverification_refused"]
  const reviewRequest = (disposition: string) => ({ ok: true, disposition,
    review_attempt_id: reviewAttemptId, reviewer_dispatch_id: reviewerId, generation: 1 })
  for (const disposition of requestDispositions) assertOutput(reviewRequest(disposition))

  const launched = { ok: true, disposition: "accepted", review_attempt_id: reviewAttemptId,
    reviewer_dispatch_id: reviewerId, generation: 2, profile: "standard" }
  assertOutput(launched)
  assertOutput({ ok: true, disposition: "recorded", review: launched })

  for (const disposition of ["accepted", "changes_requested", "inconclusive", "ambiguous",
    "canceled", "stale", "superseded"]) assertOutput({ ok: true, disposition })

  for (const disposition of ["escalation_identity_refused", "already_running",
    "already_accepted", "already_changes_requested", "already_inconclusive",
    "already_escalated", "already_failed", "already_stale", "already_superseded",
    "already_canceled", "already_ambiguous"]) {
    assertOutput({ ok: true, disposition, review_attempt_id: reviewAttemptId,
      reviewer_dispatch_id: reviewerId, generation: 2, profile: "standard" })
  }
  assertOutput({ ok: true, disposition: "escalation_exhausted", generation: 3,
    profile: "high" })

  const statusInput: ReviewStatusInput = { event: "review_status", work_id: implementationId,
    capability_token: token, thread_id: "implementation-thread", turn_id: "implementation-turn" }
  for (const profile of ["low", "standard", "high"] as const) {
    const execution = profile === "low"
      ? { model: "gpt-5.6-luna", reasoning_effort: "low" }
      : profile === "standard"
      ? { model: "gpt-5.6-terra", reasoning_effort: "medium" }
      : { model: "gpt-5.6-sol", reasoning_effort: "high" }
    const sql = (async () => [{ state: "running", result: null, findings: [],
      reviewer_dispatch_id: reviewerId, head_sha: head, base_sha: base, generation: 1,
      profile, ...execution, budget_fingerprint: reviewBudgetFingerprint(profile),
      policy_version: REVIEW_POLICY_VERSION }]) as unknown as Sql
    assertOutput(await processReviewStatus(statusInput, sql))
  }

  assert.equal(matchesSchema(outputSchema, { ...launched, unexpected: true }, outputSchema), false)
  assert.equal(matchesSchema(outputSchema, { ...launched, profile: "extreme" }, outputSchema), false)
  assert.equal(matchesSchema(outputSchema, reviewRequest("already_reserved"), outputSchema), false)
  assert.equal(matchesSchema(outputSchema, { ok: true, disposition: "escalation_exhausted",
    generation: 3, profile: "standard" }, outputSchema), false)
  assert.equal(matchesSchema(outputSchema, { ok: true, state: "running", result: null,
    findings: [], reviewer_dispatch_id: reviewerId, head_sha: head, base_sha: base,
    generation: 1, profile: "high", model: "gpt-5.6-sol", reasoning_effort: "high",
    policy_version: REVIEW_POLICY_VERSION }, outputSchema), false)
})

test("merge preflight persists its exact receipt before projecting the required success check", async () => {
  const timeline: string[] = []
  const subject = { repository, pullRequestNumber: 16, state: "open" as const,
    baseBranch: "main", headSha: head, baseSha: base,
    changedPaths: ["services/agent-control/src/independent_review.ts"],
    riskDimensions: ["architecture" as const], diffArtifactRef: "github://diff" }
  let factsCalls = 0
  const github = { loadSubject: async () => subject,
    loadMergeFacts: async () => {
      factsCalls += 1
      return { baseHeadSha: base, requiredCi: { headSha: head, conclusion: "success" as const },
        reviewCheck: { name: REVIEW_CHECK_NAME, headSha: head,
          conclusion: factsCalls === 1 ? "unknown" as const : "success" as const },
        reviewCheckRequired: true, bypassPossible: false,
        authoritativeBlockingThreads: 0, authoritativeChangesRequested: false }
    }, publishReviewCheck: async (_repository: string, _head: string, success: boolean) => {
      timeline.push(`publish:${success}`)
    } }
  const row = { work_status: "active", cancellation_requested_at: null, cancelled_at: null,
    implementation_thread_id: "implementation-thread", review_attempt_id: reviewAttemptId,
    implementation_dispatch_id: implementationId, reviewer_dispatch_id: reviewerId,
    repository, pull_request_number: 16, head_sha: head, base_sha: base, generation: 1,
    profile: "high", model: "gpt-5.6-sol", reasoning_effort: "high",
    budget_fingerprint: reviewBudgetFingerprint("high"),
    policy_version: REVIEW_POLICY_VERSION,
    reviewer_thread_id: "review-thread", reviewer_turn_id: "review-turn",
    runtime_role: "independent_reviewer", result: "accepted", findings: [],
    artifact_ref: "review://exact", result_fingerprint: `sha256:${"c".repeat(64)}` }
  const sql = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?")
    if (query.includes("from momi_agent_ops.dispatches work") &&
      query.includes("review.review_attempt_id")) return [row]
    if (query.includes("record_merge_preflight_v1")) {
      timeline.push("record:merge_preflight"); return [{ recorded: true }]
    }
    if (query.includes("record_review_check_v1")) {
      timeline.push("record:review_check"); return [{ recorded: true }]
    }
    if (query.includes("merge_review_eligible_v1")) return [{ eligible: true }]
    throw new Error(`unexpected_sql:${query}`)
  }) as unknown as Sql
  const input: MergePreflightInput = { event: "merge_preflight", work_id: implementationId,
    capability_token: token, thread_id: "implementation-thread", turn_id: "implementation-turn",
    repository, base_branch: "main", pull_request_number: 16 }
  const result = await processMergePreflight(input, sql, github as never)
  assert.equal(result.eligible, true)
  assert.deepEqual(timeline, ["record:merge_preflight", "publish:true", "record:review_check"])
})
