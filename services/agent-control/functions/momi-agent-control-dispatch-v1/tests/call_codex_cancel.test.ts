import assert from "node:assert/strict"
import test from "node:test"

import { callCodexCancel } from "../src/call_codex_cancel.ts"
import type { ClaimedDispatch } from "../src/types.ts"

test("cancels only an exact claimed target through the private host", async () => {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  const work = { work_id: "00000000-0000-4000-8000-000000000001",
    action: "cancel-run", repository: "thedoughmonster/momi-symphony", base_branch: "main",
    host_dispatch_url: "https://codex-host.example/v1/dispatch",
    target_dispatch_id: "00000000-0000-4000-8000-000000000002",
    cancellation_target_ids: ["00000000-0000-4000-8000-000000000002"] } as ClaimedDispatch
  let requestedUrl = ""; let requestedBody: Record<string, unknown> = {}
  try {
    Object.defineProperty(globalThis, "Deno", { configurable: true,
      value: { env: { get: (name: string) => name === "MOMI_CODEX_HOST_SECRET"
        ? "test-secret" : undefined } } })
    const result = await callCodexCancel(work, "capability", (url, init) => {
      requestedUrl = String(url); requestedBody = JSON.parse(String(init?.body))
      return Promise.resolve(Response.json({ cancellation_state: "requested",
        review_cancellations: [] }))
    })
    assert.deepEqual(result, { cancellation_state: "requested", review_cancellations: [] })
    assert.equal(requestedUrl, "https://codex-host.example/v1/cancel")
    assert.deepEqual(requestedBody.target_work_ids, work.cancellation_target_ids)
    assert.equal(requestedBody.schema_version, 2)
    await assert.rejects(callCodexCancel({ ...work, target_dispatch_id: null,
      cancellation_target_ids: [] }, "token"),
      /codex_host_configuration_refused/)
  } finally {
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})

test("rejects malformed or off-target reviewer cancellation receipts", async () => {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  const target = "00000000-0000-4000-8000-000000000022"
  const work = { work_id: "00000000-0000-4000-8000-000000000021",
    action: "cancel-run", repository: "thedoughmonster/momi-symphony", base_branch: "main",
    host_dispatch_url: "https://codex-host.example/v1/dispatch",
    target_dispatch_id: target, cancellation_target_ids: [target] } as ClaimedDispatch
  try {
    Object.defineProperty(globalThis, "Deno", { configurable: true,
      value: { env: { get: () => "test-secret" } } })
    for (const receipt of [
      { reviewer_dispatch_id: target, capability_token: "not-a-uuid",
        host_state: "canceled", identities_complete: false, interruption_confirmed: false },
      { reviewer_dispatch_id: "00000000-0000-4000-8000-000000000023",
        capability_token: "00000000-0000-4000-8000-000000000024",
        host_state: "canceled", identities_complete: false, interruption_confirmed: false },
    ]) {
      await assert.rejects(callCodexCancel(work, "capability", () => Promise.resolve(
        Response.json({ cancellation_state: "requested", review_cancellations: [receipt] }))),
      /codex_host_cancellation_receipt_invalid/)
    }
  } finally {
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})
