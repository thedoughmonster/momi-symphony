import assert from "node:assert/strict"
import test from "node:test"

import { claimDispatch } from "../src/claim_dispatch.ts"
import { processDispatch } from "../src/process_dispatch.ts"
import type { ClaimedDispatch, DispatchInput } from "../src/types.ts"

const input: DispatchInput = { work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002" }

test("authenticated cancellation keeps reserved and receipted reviewer targets stable", async () => {
  const implementationId = "00000000-0000-4000-8000-000000000003"
  const reviewerId = "00000000-0000-4000-8000-000000000004"
  const queries: string[] = []; let reviewerState = "reserved"
  const sql = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const query = strings.join("?"); queries.push(query)
    if (query.includes("claim_dispatch_v6")) return [{ work_id: input.work_id,
      action: "cancel-run", delivery_phase: "cancel_host",
      cancellation_target_ids: [implementationId] }]
    if (query.includes("prepare_review_check_revocations_v1")) return []
    if (query.includes("fence_cancellation_v1")) return [{ fenced: true }]
    if (query.includes("from momi_agent_ops.review_attempts")) {
      return query.includes(`'${reviewerState}'`) ? [{ reviewer_dispatch_id: reviewerId }] : []
    }
    throw new Error("unexpected_query")
  }
  const reservedClaim = await claimDispatch(input, sql as never)
  reviewerState = "canceled"
  const replayClaim = await claimDispatch(input, sql as never)
  assert.deepEqual(reservedClaim?.cancellation_target_ids, [implementationId, reviewerId])
  assert.deepEqual(replayClaim?.cancellation_target_ids,
    reservedClaim?.cancellation_target_ids)
  for (const query of [queries[3], queries[7]]) {
    assert.match(query,
      /state in \('reserved', 'running', 'changes_requested', 'ambiguous', 'canceled'\)/)
    assert.doesNotMatch(query, /reviewer_thread_id is not null/)
  }
})

test("cancellation publishes and records exact-head revocation before its durable fence", async () => {
  const implementationId = "00000000-0000-4000-8000-000000000013"
  const head = "a".repeat(40); const timeline: string[] = []
  const sql = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const query = strings.join("?")
    if (query.includes("claim_dispatch_v6")) return [{ work_id: input.work_id,
      action: "cancel-run", delivery_phase: "cancel_host",
      cancellation_target_ids: [implementationId] }]
    if (query.includes("prepare_review_check_revocations_v1")) {
      timeline.push("prepare")
      return [{ implementation_dispatch_id: implementationId,
        repository: "thedoughmonster/momi-symphony", head_sha: head,
        publication_pending: false, revocation_required: true }]
    }
    if (query.includes("record_review_check_revocation_v1")) {
      timeline.push("record-revocation"); return [{ recorded: true }]
    }
    if (query.includes("fence_cancellation_v1")) {
      timeline.push("fence"); return [{ fenced: true }]
    }
    if (query.includes("from momi_agent_ops.review_attempts")) return []
    throw new Error(`unexpected_query:${query}`)
  }
  const github = { publishReviewCheck: async (repository: string, sha: string,
    success: boolean) => {
    assert.equal(repository, "thedoughmonster/momi-symphony")
    assert.equal(sha, head); assert.equal(success, false); timeline.push("publish-failure")
  } }
  await claimDispatch(input, sql as never, github as never)
  assert.deepEqual(timeline, ["prepare", "publish-failure", "record-revocation", "fence"])
})

test("cancellation waits while an exact-head success publication lease is active", async () => {
  let published = false
  const sql = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const query = strings.join("?")
    if (query.includes("claim_dispatch_v6")) return [{ work_id: input.work_id,
      action: "cancel-run", delivery_phase: "cancel_host",
      cancellation_target_ids: ["00000000-0000-4000-8000-000000000023"] }]
    if (query.includes("prepare_review_check_revocations_v1")) return [{
      implementation_dispatch_id: "00000000-0000-4000-8000-000000000023",
      repository: "thedoughmonster/momi-symphony", head_sha: "a".repeat(40),
      publication_pending: true, revocation_required: true }]
    throw new Error("must_not_continue_after_publication_lease")
  }
  await assert.rejects(claimDispatch(input, sql as never, {
    publishReviewCheck: async () => { published = true },
  } as never), /review_check_publication_pending/)
  assert.equal(published, false)
})

test("one claimed dispatch creates one host task and replay is duplicate", async () => {
  let claimCount = 0; let hostCount = 0; let writebacks = 0
  const work = { work_id: input.work_id, issue_id: "issue", issue_identifier: "MOX-151",
    action: "execute-run",
    issue_url: "https://linear.app/issue", project_id: "project",
    project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
    base_branch: "main", active_states: ["Todo"],
    host_dispatch_url: "https://codex-host.example/v1/dispatch", rejection_code: null,
    delivery_phase: "host", thread_id: null, turn_id: null,
    linear_comment_id: null } as ClaimedDispatch
  const dependencies = { claim: () => Promise.resolve(
    claimCount++ === 0 ? { ...work } : null),
    callHost: () => { hostCount += 1; return Promise.resolve(
      { thread_id: "thread-1", turn_id: "turn-1" }) },
    callCancel: () => Promise.reject(new Error("must_not_cancel")),
    callRecovery: () => Promise.reject(new Error("must_not_recover")),
    hostAccepted: () => Promise.resolve(true), reconcile: () => Promise.resolve("comment-1"),
    cancellationRecorded: () => Promise.resolve(true),
    recoveryRecorded: () => Promise.resolve(true),
    writeback: () => { writebacks += 1; return Promise.resolve(true) },
    retry: () => Promise.resolve(true),
    project: () => Promise.resolve() }
  assert.deepEqual(await processDispatch(input, dependencies),
    { ok: true, disposition: "active", thread_id: "thread-1" })
  assert.deepEqual(await processDispatch(input, dependencies),
    { ok: true, disposition: "duplicate" })
  assert.equal(hostCount, 1); assert.equal(writebacks, 1)
})

test("unknown project writes an explanation without creating a task", async () => {
  let hostCount = 0; let writebacks = 0
  const work = { work_id: input.work_id, issue_id: "issue", issue_identifier: "MOX-151",
    action: "validate-issue",
    issue_url: "https://linear.app/issue", project_id: "unknown", project_name: "Other",
    repository: null, base_branch: null, active_states: null, host_dispatch_url: null,
    rejection_code: "unknown_project", delivery_phase: "writeback",
    thread_id: null, turn_id: null, linear_comment_id: null } as ClaimedDispatch
  const result = await processDispatch(input, { claim: () => Promise.resolve(work),
    callHost: () => { hostCount += 1; return Promise.reject(new Error("must_not_call")) },
    callCancel: () => Promise.reject(new Error("must_not_cancel")),
    callRecovery: () => Promise.reject(new Error("must_not_recover")),
    hostAccepted: () => Promise.resolve(true), reconcile: () => Promise.resolve("comment-2"),
    cancellationRecorded: () => Promise.resolve(true),
    recoveryRecorded: () => Promise.resolve(true),
    writeback: () => { writebacks += 1; return Promise.resolve(true) },
    retry: () => Promise.resolve(true), project: () => Promise.resolve() })
  assert.equal(result.disposition, "rejected")
  assert.equal(hostCount, 0); assert.equal(writebacks, 1)
})

test("delivery failure releases the durable claim for retry", async () => {
  let retries = 0
  const work = { work_id: input.work_id, delivery_phase: "host",
    rejection_code: null } as ClaimedDispatch
  await assert.rejects(processDispatch(input, { claim: () => Promise.resolve(work),
    callHost: () => Promise.reject(new Error("host_unavailable")),
    callCancel: () => Promise.reject(new Error("must_not_cancel")),
    callRecovery: () => Promise.reject(new Error("must_not_recover")),
    hostAccepted: () => Promise.resolve(true), reconcile: () => Promise.resolve(null),
    cancellationRecorded: () => Promise.resolve(true),
    recoveryRecorded: () => Promise.resolve(true),
    writeback: () => Promise.resolve(true), retry: () => {
      retries += 1; return Promise.resolve(true) }, project: () => Promise.resolve() }))
  assert.equal(retries, 1)
})

test("active cancellation records the host result and projects the exact target", async () => {
  let recorded = false; const projected: string[] = []
  const work = { work_id: input.work_id, issue_id: "issue", issue_identifier: "MOX-153",
    action: "cancel-run", rejection_code: null, delivery_phase: "cancel_host",
    target_dispatch_id: "00000000-0000-4000-8000-000000000003",
    cancellation_state: "requested" } as ClaimedDispatch
  const result = await processDispatch(input, { claim: () => Promise.resolve(work),
    callHost: () => Promise.reject(new Error("must_not_start")),
    callCancel: () => Promise.resolve({ cancellation_state: "requested",
      review_cancellations: [] }),
    callRecovery: () => Promise.reject(new Error("must_not_recover")),
    hostAccepted: () => Promise.resolve(true), cancellationRecorded: () => {
      recorded = true; return Promise.resolve(true) },
    recoveryRecorded: () => Promise.resolve(true),
    reconcile: () => Promise.resolve("comment-3"), writeback: () => Promise.resolve(true),
    retry: () => Promise.resolve(true),
    project: (id) => { projected.push(id); return Promise.resolve() } })
  assert.equal(result.disposition, "requested")
  assert.equal(recorded, true)
  assert.deepEqual(projected, [work.target_dispatch_id])
})
