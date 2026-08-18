import assert from "node:assert/strict"
import test from "node:test"

import { processDispatch } from "../src/process_dispatch.ts"
import type { ClaimedDispatch, DispatchInput } from "../src/types.ts"

test("recovery writes pending status, calls only recovery, and never adds has-run", async () => {
  const input: DispatchInput = { work_id: "00000000-0000-4000-8000-000000000001",
    capability_token: "00000000-0000-4000-8000-000000000002" }
  const work = { work_id: input.work_id, issue_id: "issue", issue_identifier: "MOX-159",
    action: "recover-discovery", rejection_code: null, delivery_phase: "recover_host",
    target_dispatch_id: "00000000-0000-4000-8000-000000000003",
    recovery_state: "requested", thread_id: null } as ClaimedDispatch
  let reconciles = 0; let recorded = false; let marker = true
  const result = await processDispatch(input, { claim: () => Promise.resolve(work),
    callHost: () => Promise.reject(new Error("must_not_start")),
    callCancel: () => Promise.reject(new Error("must_not_cancel")),
    callRecovery: () => Promise.resolve({ recovery_state: "recovered" }),
    hostAccepted: () => Promise.resolve(true),
    cancellationRecorded: () => Promise.resolve(true),
    recoveryRecorded: () => { recorded = true; return Promise.resolve(true) },
    reconcile: () => { reconciles += 1; return Promise.resolve("comment") },
    writeback: (_input, _comment, hasRun) => {
      marker = hasRun; return Promise.resolve(true) }, retry: () => Promise.resolve(true) })
  assert.deepEqual(result, { ok: true, disposition: "recovered" })
  assert.equal(reconciles, 2); assert.equal(recorded, true); assert.equal(marker, false)
})

test("mapping mismatch is written back without any host mutation", async () => {
  const input = { work_id: "work", capability_token: "token" }
  const work = { work_id: input.work_id, issue_id: "issue", issue_identifier: "MOX-159",
    action: "recover-discovery", rejection_code: null, delivery_phase: "writeback",
    recovery_state: "mapping_mismatch" } as ClaimedDispatch
  let hostCalls = 0
  const result = await processDispatch(input, { claim: () => Promise.resolve(work),
    callHost: () => { hostCalls += 1; return Promise.reject(new Error("unexpected")) },
    callCancel: () => { hostCalls += 1; return Promise.reject(new Error("unexpected")) },
    callRecovery: () => { hostCalls += 1; return Promise.reject(new Error("unexpected")) },
    hostAccepted: () => Promise.resolve(true), cancellationRecorded: () => Promise.resolve(true),
    recoveryRecorded: () => Promise.resolve(true), reconcile: () => Promise.resolve("comment"),
    writeback: () => Promise.resolve(true), retry: () => Promise.resolve(true) })
  assert.deepEqual(result, { ok: true, disposition: "mapping_mismatch" })
  assert.equal(hostCalls, 0)
})
