import assert from "node:assert/strict"
import test from "node:test"

import { processDispatch } from "../src/process_dispatch.ts"
import type { ClaimedDispatch, DispatchInput } from "../src/types.ts"

const input: DispatchInput = { work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002" }

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
    callCancel: () => Promise.resolve({ cancellation_state: "requested" }),
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
