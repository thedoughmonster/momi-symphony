import assert from "node:assert/strict"
import test from "node:test"

import { callCodexCancel } from "../src/call_codex_cancel.ts"
import type { ClaimedDispatch } from "../src/types.ts"

test("cancels the exact database-selected target set through the private host", async () => {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  const work = { work_id: "00000000-0000-4000-8000-000000000001",
    action: "cancel-run", repository: "thedoughmonster/momi-symphony", base_branch: "main",
    host_dispatch_url: "https://codex-host.example/v1/dispatch",
    cancellation_target_ids: ["00000000-0000-4000-8000-000000000002"] } as ClaimedDispatch
  try {
    Object.defineProperty(globalThis, "Deno", { configurable: true,
      value: { env: { get: () => "test-secret" } } })
    let body: Record<string, unknown> = {}
    const result = await callCodexCancel(work, "capability", (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Promise.resolve(Response.json({ cancellation_state: "requested" }))
    })
    assert.deepEqual(result, { cancellation_state: "requested" })
    assert.deepEqual(body.target_work_ids, work.cancellation_target_ids)
    await assert.rejects(callCodexCancel({ ...work, cancellation_target_ids: [] }, "token"),
      /codex_host_configuration_refused/)
  } finally {
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})

test("rejects an invalid host cancellation state", async () => {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  try {
    Object.defineProperty(globalThis, "Deno", { configurable: true,
      value: { env: { get: () => "test-secret" } } })
    const work = { repository: "a/b", base_branch: "main",
      host_dispatch_url: "https://host.example/v1/dispatch",
      cancellation_target_ids: ["00000000-0000-4000-8000-000000000002"] } as ClaimedDispatch
    await assert.rejects(callCodexCancel(work, "token", () => Promise.resolve(
      Response.json({ cancellation_state: "unknown" }))), /codex_host_cancellation_failed/)
  } finally {
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})
