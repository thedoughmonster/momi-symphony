import assert from "node:assert/strict"
import test from "node:test"

import {
  readSchedulerPumpConfiguration,
  SchedulerPump,
} from "../src/scheduler_pump.ts"

const schedulerId = "00000000-0000-4000-8000-000000000001"
const workId = "00000000-0000-4000-8000-000000000002"
const releaseSha = "a".repeat(40)
const callbackUrl = new URL("https://agent-control.example/v1/dispatch")
const receipt = { ok: true as const, routes: 1, observed: 1, claimed: 0,
  technical_retries: 0, projection_retries: 0, projection_failures: 0 }

test("scheduler pump remains disabled unless explicitly enabled", () => {
  assert.deepEqual(readSchedulerPumpConfiguration({}), {
    enabled: false, intervalMs: 15_000, releaseSha: null,
  })
  assert.deepEqual(readSchedulerPumpConfiguration({
    MOMI_AGENT_CONTROL_SCHEDULER_ENABLED: "True",
    MOMI_AGENT_CONTROL_SCHEDULER_INTERVAL_MS: "invalid",
  }), { enabled: false, intervalMs: 15_000, releaseSha: null })
  assert.deepEqual(readSchedulerPumpConfiguration({
    MOMI_AGENT_CONTROL_SCHEDULER_ENABLED: "true",
    MOMI_AGENT_CONTROL_SCHEDULER_INTERVAL_MS: "10000",
    MOMI_AGENT_CONTROL_RELEASE_SHA: releaseSha,
  }), { enabled: true, intervalMs: 10_000, releaseSha })
  assert.throws(() => readSchedulerPumpConfiguration({
    MOMI_AGENT_CONTROL_SCHEDULER_ENABLED: "true",
    MOMI_AGENT_CONTROL_SCHEDULER_INTERVAL_MS: "9999",
    MOMI_AGENT_CONTROL_RELEASE_SHA: releaseSha,
  }), /scheduler_configuration_invalid/)
  assert.throws(() => readSchedulerPumpConfiguration({
    MOMI_AGENT_CONTROL_SCHEDULER_ENABLED: "true",
    MOMI_AGENT_CONTROL_RELEASE_SHA: "unprotected",
  }), /scheduler_configuration_invalid/)
})

test("host pump sends only scheduler identity and bounded host evidence", async () => {
  const requests: Array<{ input: URL | RequestInfo; init?: RequestInit }> = []
  const pump = new SchedulerPump({ callbackUrl, secret: "private-secret",
    intervalMs: 15_000, schedulerId, releaseSha, activeWorkIds: () => [workId],
    fetchImpl: ((input, init) => {
      requests.push({ input, init })
      return Promise.resolve(Response.json(receipt))
    }) as typeof fetch })

  assert.deepEqual(await pump.pump(), receipt)
  assert.deepEqual(await pump.pump(), receipt)
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(String(request.input), callbackUrl.href)
    assert.equal(request.init?.method, "POST")
    assert.deepEqual(request.init?.headers, {
      Authorization: "Bearer private-secret", "Content-Type": "application/json",
    })
    assert.deepEqual(JSON.parse(String(request.init?.body)), {
      event: "scheduler_pump", scheduler_id: schedulerId, release_sha: releaseSha,
      active_work_ids: [workId],
    })
    assert.doesNotMatch(String(request.init?.body), /issue|linear|label|dispatchable/i)
  }
})

test("concurrent timer replay never overlaps an in-flight pump", async () => {
  let release: (() => void) | undefined
  let calls = 0
  const pending = new Promise<void>((resolve) => { release = resolve })
  const pump = new SchedulerPump({ callbackUrl, secret: "private-secret",
    intervalMs: 15_000, schedulerId, releaseSha, activeWorkIds: () => [],
    fetchImpl: (async () => {
      calls += 1
      await pending
      return Response.json(receipt)
    }) as typeof fetch })

  const first = pump.pump()
  assert.equal(await pump.pump(), null)
  assert.equal(calls, 1)
  release!()
  assert.deepEqual(await first, receipt)
  assert.deepEqual(await pump.pump(), receipt)
  assert.equal(calls, 2)
})
