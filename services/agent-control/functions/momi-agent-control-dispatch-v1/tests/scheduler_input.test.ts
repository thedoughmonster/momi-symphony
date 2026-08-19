import assert from "node:assert/strict"
import test from "node:test"

import { handleRequestWithDependencies } from "../src/handle_request_with_dependencies.ts"
import { parseDispatchInput } from "../src/parse_dispatch_input.ts"

const schedulerId = "00000000-0000-4000-8000-000000000001"
const workId = "00000000-0000-4000-8000-000000000002"
const releaseSha = "a".repeat(40)

test("scheduler pump input is exact, bounded, and replay-safe", () => {
  assert.deepEqual(parseDispatchInput({ event: "scheduler_pump",
    scheduler_id: schedulerId, release_sha: releaseSha, active_work_ids: [workId] }), {
    event: "scheduler_pump", scheduler_id: schedulerId, release_sha: releaseSha,
    active_work_ids: [workId],
  })
  assert.equal(parseDispatchInput({ event: "scheduler_pump",
    scheduler_id: schedulerId, release_sha: releaseSha,
    active_work_ids: [workId, workId] }), null)
  assert.equal(parseDispatchInput({ event: "scheduler_pump",
    scheduler_id: schedulerId, release_sha: releaseSha,
    active_work_ids: [], issue_ids: [] }), null)
  assert.equal(parseDispatchInput({ event: "scheduler_pump",
    scheduler_id: schedulerId, release_sha: releaseSha,
    active_work_ids: Array.from({ length: 129 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`) }), null)
  assert.equal(parseDispatchInput({ event: "scheduler_pump",
    scheduler_id: schedulerId, release_sha: "b".repeat(39), active_work_ids: [] }), null)
})

test("scheduler pump reuses the host-authenticated control-plane boundary", async () => {
  const input = { event: "scheduler_pump" as const, scheduler_id: schedulerId,
    release_sha: releaseSha, active_work_ids: [workId] }
  let calls = 0
  const injected = { hostSecret: "private-host-secret",
    schedulerPump: async (received: typeof input) => {
      calls += 1
      assert.deepEqual(received, input)
      return { ok: true as const, routes: 0, observed: 0, claimed: 0,
        technical_retries: 0 }
    } }
  const unauthorized = await handleRequestWithDependencies(new Request(
    "https://agent-control.example/v1/dispatch",
    { method: "POST", body: JSON.stringify(input) },
  ), injected as never)
  assert.equal(unauthorized.status, 401)
  assert.equal(calls, 0)

  const authorized = await handleRequestWithDependencies(new Request(
    "https://agent-control.example/v1/dispatch",
    { method: "POST", headers: { Authorization: "Bearer private-host-secret" },
      body: JSON.stringify(input) },
  ), injected as never)
  assert.equal(authorized.status, 200)
  assert.equal(calls, 1)
  assert.deepEqual(await authorized.json(), { ok: true, routes: 0, observed: 0,
    claimed: 0, technical_retries: 0 })
})
