import assert from "node:assert/strict"
import test from "node:test"

import { reconcileLinear } from "../src/reconcile_linear.ts"
import type { ClaimedDispatch } from "../src/types.ts"

test("consumes the accepted action, adds has-run, and writes its marker", async () => {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  const priorFetch = globalThis.fetch
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = []
  Object.defineProperty(globalThis, "Deno", { configurable: true,
    value: { env: { get: (name: string) => name === "LINEAER_ACCESS" ? "token" : undefined } } })
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string; variables: Record<string, unknown>
    }
    requests.push(request)
    if (request.query.includes("AgentControlIssue")) return Promise.resolve(
      Response.json({ data: { issue: {
      id: "00000000-0000-4000-8000-000000000010", identifier: "MOX-151",
      state: { name: "Todo" }, labels: { nodes: [
        { id: "action-id", name: "decompose" }, { id: "feature-id", name: "Feature" }] },
      team: { labels: { nodes: [{ id: "action-id", name: "decompose" },
        { id: "has-id", name: "has-run" }] } }, comments: { nodes: [] } } } }))
    if (request.query.includes("AgentControlLabels")) {
      return Promise.resolve(Response.json({ data: { issueUpdate: { success: true } } }))
    }
    return Promise.resolve(Response.json({ data: { commentCreate: {
      success: true, comment: { id: "00000000-0000-4000-8000-000000000011" } } } }))
  }) as typeof fetch
  try {
    const work = { work_id: "00000000-0000-4000-8000-000000000001",
      issue_id: "00000000-0000-4000-8000-000000000010", issue_identifier: "MOX-151",
      issue_url: "https://linear.app/issue/MOX-151", project_id: "project",
      action: "decompose",
      project_name: "Symphony Control Plane", repository: "thedoughmonster/momi-symphony",
      base_branch: "main", active_states: ["Todo"], rejection_code: null,
      delivery_phase: "writeback", thread_id: "thread-1", turn_id: "turn-1",
      linear_comment_id: null } as ClaimedDispatch
    assert.equal(await reconcileLinear(work), "00000000-0000-4000-8000-000000000011")
    const labels = requests.find((request) => request.query.includes("AgentControlLabels"))
    assert.deepEqual(labels?.variables.labelIds, ["feature-id", "has-id"])
    const comment = requests.find((request) => request.query.includes("CommentCreate"))
    assert.match(String(comment?.variables.body), /momi-agent-control:00000000/)
    assert.match(String(comment?.variables.body), /Action: `decompose`/)
    assert.match(String(comment?.variables.body), /Symphony: intentionally not invoked/)
  } finally {
    globalThis.fetch = priorFetch
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})
