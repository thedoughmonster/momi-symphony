import assert from "node:assert/strict"
import test from "node:test"

import { callCodexHost } from "../src/call_codex_host.ts"
import type { ClaimedDispatch } from "../src/types.ts"

test("uses the claimed private HTTPS endpoint and runtime bearer secret", async () => {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  const work = { work_id: "work", issue_id: "issue", issue_identifier: "MOX-154",
    action: "execute-run",
    issue_url: "https://linear.app/issue", project_id: "project",
    project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
    base_branch: "main", active_states: ["Todo"],
    host_dispatch_url: "https://codex-host.example/v1/dispatch", rejection_code: null,
    delivery_phase: "host", thread_id: null, turn_id: null,
    linear_comment_id: null } as ClaimedDispatch
  let requestedUrl = ""; let authorization = ""; let requestedBody = ""
  try {
    Object.defineProperty(globalThis, "Deno", { configurable: true,
      value: { env: { get: (name: string) => name === "MOMI_CODEX_HOST_SECRET"
        ? "test-secret" : undefined } } })
    const accepted = await callCodexHost(work, "capability", (url, init) => {
      requestedUrl = String(url)
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      requestedBody = String(init?.body ?? "")
      return Promise.resolve(Response.json({ thread_id: "thread", turn_id: "turn" }))
    })
    assert.deepEqual(accepted, { thread_id: "thread", turn_id: "turn" })
    assert.equal(requestedUrl, work.host_dispatch_url)
    assert.equal(authorization, "Bearer test-secret")
    assert.match(requestedBody, /"schema_version":2/)
    assert.match(requestedBody, /"interaction_mode":"one_shot"/)
    assert.match(requestedBody, /"thread_name":"MOX-154 · execute-run"/)
    await callCodexHost({ ...work, action: "run-discovery" }, "capability", (_url, init) => {
      requestedBody = String(init?.body ?? "")
      return Promise.resolve(Response.json({ thread_id: "discovery", turn_id: "question" }))
    })
    assert.match(requestedBody, /"interaction_mode":"interactive"/)
    assert.match(requestedBody, /"thread_name":"MOX-154 · interactive discovery"/)
    await assert.rejects(callCodexHost({ ...work,
      action: "recover-discovery" }, "token"), /recovery_requires_recovery_endpoint/)
    await assert.rejects(callCodexHost({ ...work, host_dispatch_url: null }, "token"),
      /codex_host_url_unconfigured/)
    await assert.rejects(callCodexHost({ ...work,
      host_dispatch_url: "http://public.example/v1/dispatch" }, "token"),
    /codex_host_configuration_refused/)
  } finally {
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})
