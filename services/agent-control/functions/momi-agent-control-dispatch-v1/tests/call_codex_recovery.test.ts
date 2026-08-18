import assert from "node:assert/strict"
import test from "node:test"

import { callCodexRecovery } from "../src/call_codex_recovery.ts"
import type { ClaimedDispatch } from "../src/types.ts"

test("recovers only an exact retained target through the private host", async () => {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  Object.defineProperty(globalThis, "Deno", { configurable: true,
    value: { env: { get: () => "host-secret" } } })
  let requestedUrl = ""; let requestedBody = ""
  const work = { work_id: "00000000-0000-4000-8000-000000000001",
    action: "recover-discovery", repository: "thedoughmonster/momi-symphony",
    base_branch: "main", host_dispatch_url: "https://codex-host.example/v1/dispatch",
    target_dispatch_id: "00000000-0000-4000-8000-000000000002" } as ClaimedDispatch
  try {
    const result = await callCodexRecovery(work,
      "00000000-0000-4000-8000-000000000003", (url, init) => {
        requestedUrl = String(url); requestedBody = String(init?.body)
        return Promise.resolve(Response.json({ recovery_state: "recovered" }))
      })
    assert.deepEqual(result, { recovery_state: "recovered" })
    assert.equal(requestedUrl, "https://codex-host.example/v1/recover")
    assert.match(requestedBody, /"target_work_id":"00000000-0000-4000-8000-000000000002"/)
    assert.doesNotMatch(requestedBody, /thread|repository|base_branch/)
  } finally {
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})
