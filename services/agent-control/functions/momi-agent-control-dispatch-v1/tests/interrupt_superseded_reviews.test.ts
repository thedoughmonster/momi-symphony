import assert from "node:assert/strict"
import test from "node:test"
import type { Sql } from "postgres"

import { interruptSupersededReviews } from "../src/interrupt_superseded_reviews.ts"
import type { LifecycleEvidenceInput } from "../src/types.ts"

const input: LifecycleEvidenceInput = { event: "lifecycle_evidence",
  work_id: "00000000-0000-4000-8000-000000000001",
  capability_token: "00000000-0000-4000-8000-000000000002",
  thread_id: "implementation-thread", turn_id: "implementation-turn",
  repository: "thedoughmonster/momi-symphony", base_branch: "main",
  branch_name: "mox-260-independent-pr-review", pull_request_number: 16,
  phase: "validating", status: "succeeded", revision_sha: "a".repeat(40),
  workflow_run_id: "123" }

test("superseded reviewer interruption request waits for an exact terminal callback", async () => {
  const originalDeno = (globalThis as Record<string, unknown>).Deno
  ;(globalThis as Record<string, unknown>).Deno = { env: { get: (name: string) =>
    name === "MOMI_CODEX_HOST_SECRET" ? "host-secret" : undefined } }
  const queries: string[] = []
  const reviewerId = "00000000-0000-4000-8000-000000000003"
  const sql = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join("?"))
    return [{ reviewer_dispatch_id: reviewerId,
      host_dispatch_url: "https://host.example/v1/dispatch" }]
  }) as unknown as Sql
  try {
    await interruptSupersededReviews(input, sql, async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization,
        "Bearer host-secret")
      assert.deepEqual(JSON.parse(String(init?.body)), { schema_version: 2,
        work_id: reviewerId, capability_token: input.capability_token,
        target_work_ids: [reviewerId], repository: input.repository,
        base_branch: input.base_branch })
      return Response.json({ cancellation_state: "requested" })
    })
    assert.equal(queries.length, 1)
    assert.match(queries[0], /interruption_confirmed_at is null/)
  } finally {
    if (originalDeno === undefined) delete (globalThis as Record<string, unknown>).Deno
    else (globalThis as Record<string, unknown>).Deno = originalDeno
  }
})
