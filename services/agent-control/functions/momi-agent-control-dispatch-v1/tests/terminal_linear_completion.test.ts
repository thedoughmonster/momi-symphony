import assert from "node:assert/strict"
import test from "node:test"

import { reconcileTerminal } from "../src/reconcile_terminal.ts"
import type { TerminalContext, TerminalInput } from "../src/types.ts"

const context = { issue_id: "00000000-0000-4000-8000-000000000010",
  issue_identifier: "MOX-253", action: "execute-run",
  linear_comment_id: "00000000-0000-4000-8000-000000000011" } as TerminalContext
const terminal = { event: "terminal",
  work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002",
  thread_id: "thread-1", turn_id: "turn-1", readiness_result: "ready",
  terminal_disposition: "completed", archived_at: "2026-08-19T12:00:00Z",
  summary: "Merged and verified." } as TerminalInput

test("terminal reconciliation atomically preserves labels and completes a ready execution", async () => {
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
        id: context.issue_id, identifier: context.issue_identifier,
        title: "Automatic prerequisite", description: "## Acceptance criteria\n\n- Complete.",
        priority: 4, branchName: null, url: "https://linear.app/issue/MOX-253",
        createdAt: null, updatedAt: null,
        state: { id: "todo-id", name: "Todo", type: "unstarted" }, assignee: null,
        project: { id: "project" }, labels: { nodes: [
          { id: "implementation-id", name: "Implementation" },
          { id: "ready-id", name: "ready-package" },
          { id: "has-id", name: "has-run" }],
          pageInfo: { hasNextPage: false, endCursor: null } },
        team: { id: "team", labels: { nodes: [
          { id: "action-id", name: "execute-run" },
          { id: "has-id", name: "has-run" }] },
          states: { nodes: [
            { id: "todo-id", name: "Todo", type: "unstarted" },
            { id: "done-id", name: "Done", type: "completed" }],
            pageInfo: { hasNextPage: false, endCursor: null } } },
        parent: null,
        children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        inverseRelations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: { nodes: [{ id: context.linear_comment_id,
          body: "<!-- momi-agent-control:00000000-0000-4000-8000-000000000001 --> pending" }] }
      } } }))
    if (request.query.includes("AgentControlCompletion")) return Promise.resolve(
      Response.json({ data: { issueUpdate: { success: true,
        issue: { state: { id: "done-id", type: "completed" } } } } }))
    if (request.query.includes("AgentControlCommentUpdate")) return Promise.resolve(
      Response.json({ data: { commentUpdate: { success: true,
        comment: { id: context.linear_comment_id } } } }))
    return Promise.reject(new Error("unexpected_linear_operation"))
  }) as typeof fetch
  try {
    assert.equal(await reconcileTerminal(context, terminal), context.linear_comment_id)
    const read = requests.find((request) => request.query.includes("AgentControlIssue"))
    assert.match(String(read?.query), /states\(first: 50\)/)
    const completion = requests.find((request) =>
      request.query.includes("AgentControlCompletion"))
    assert.deepEqual(completion?.variables, { id: context.issue_id,
      labelIds: ["has-id", "implementation-id", "ready-id"], stateId: "done-id" })
    assert.equal(requests.filter((request) =>
      request.query.includes("issueUpdate")).length, 1)
    const comment = requests.find((request) =>
      request.query.includes("AgentControlCommentUpdate"))
    assert.match(String(comment?.variables.body), /Final disposition: completed/)
    assert.match(String(comment?.variables.body), /Readiness: ready/)
  } finally {
    globalThis.fetch = priorFetch
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})
