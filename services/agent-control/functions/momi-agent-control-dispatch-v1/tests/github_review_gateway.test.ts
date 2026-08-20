import assert from "node:assert/strict"
import test from "node:test"

import { GitHubReviewGateway } from "../src/github_review_gateway.ts"

const head = "a".repeat(40)
const base = "b".repeat(40)

function response(value: unknown): Response { return Response.json(value) }

test("GitHub review gateway freezes exact PR identity and fail-closed merge facts", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const gateway = new GitHubReviewGateway(async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url.endsWith("/pulls/16")) return response({ state: "open",
      head: { sha: head }, base: { sha: base, ref: "main" } })
    if (url.includes("/pulls/16/files")) return response([
      { filename: "services/agent-control/src/independent_review.ts" },
      { filename: "supabase/migrations/next.sql" },
    ])
    if (url.endsWith(`/commits/${head}/check-runs`)) return response({ check_runs: [
      { name: "CI", conclusion: "success" },
    ] })
    if (url.endsWith(`/commits/${head}/statuses`)) return response([
      { context: "Symphony Independent Review", state: "success" },
    ])
    if (url.endsWith("/branches/main/protection")) return response({
      required_status_checks: { contexts: ["CI", "Symphony Independent Review"], checks: [] },
      enforce_admins: { enabled: true }, allow_force_pushes: false, allow_deletions: false,
    })
    if (url.endsWith("/pulls/16/reviews")) return response([
      { id: 1, user: { login: "reviewer" }, state: "CHANGES_REQUESTED" },
      { id: 2, user: { login: "reviewer" }, state: "APPROVED" },
    ])
    if (url.endsWith("/graphql")) return response({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false } },
    } } } })
    if (url.endsWith(`/statuses/${head}`)) return response({ id: 1 })
    if (url.includes(`/compare/${base}...${head}`)) return response({ files: [
      { filename: "services/agent-control/src/independent_review.ts" }] })
    return new Response("missing", { status: 404 })
  }, "review-token")
  const subject = await gateway.loadSubject("thedoughmonster/momi-symphony", 16)
  assert.equal(subject.headSha, head)
  assert.equal(subject.baseSha, base)
  assert.deepEqual(subject.changedPaths, [
    "services/agent-control/src/independent_review.ts", "supabase/migrations/next.sql"])
  const facts = await gateway.loadMergeFacts(subject.repository, "main", 16, head)
  assert.equal(facts.requiredCi.conclusion, "success")
  assert.equal(facts.reviewCheck.conclusion, "success")
  assert.equal(facts.reviewCheckRequired, true)
  assert.equal(facts.bypassPossible, false)
  assert.equal(facts.authoritativeBlockingThreads, 0)
  assert.equal(facts.authoritativeChangesRequested, false)
  assert.deepEqual(await gateway.compareChangedPaths(subject.repository, base, head),
    ["services/agent-control/src/independent_review.ts"])
  await gateway.publishReviewCheck(subject.repository, head, true, "accepted")
  const publish = calls.find((call) => call.url.endsWith(`/statuses/${head}`))
  assert.equal((JSON.parse(String(publish?.init?.body)) as Record<string, unknown>).context,
    "Symphony Independent Review")
  assert.equal(calls.some((call) => String((call.init?.headers as Record<string, string>)
    ?.Authorization).includes("review-token")), true)
})

test("unknown review-thread authority remains ineligible evidence", async () => {
  const gateway = new GitHubReviewGateway(async (input) => {
    const url = String(input)
    if (url.endsWith(`/commits/${head}/check-runs`)) return response({ check_runs: [] })
    if (url.endsWith(`/commits/${head}/statuses`)) return response([])
    if (url.endsWith("/branches/main/protection")) return response({
      required_status_checks: { contexts: [] }, enforce_admins: { enabled: false } })
    if (url.endsWith("/pulls/16/reviews")) return response([])
    return new Response("forbidden", { status: 403 })
  }, "review-token")
  const facts = await gateway.loadMergeFacts("thedoughmonster/momi-symphony", "main", 16, head)
  assert.equal(facts.authoritativeBlockingThreads, -1)
  assert.equal(facts.requiredCi.conclusion, "unknown")
  assert.equal(facts.reviewCheckRequired, false)
  assert.equal(facts.bypassPossible, true)
})
