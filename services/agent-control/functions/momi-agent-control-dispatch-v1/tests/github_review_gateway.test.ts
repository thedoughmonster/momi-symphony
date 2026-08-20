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
      { context: "Symphony Independent Review", state: "success",
        creator: { login: "review-publisher" } },
    ])
    if (url.endsWith("/branches/main")) return response({ commit: { sha: base } })
    if (url.endsWith("/branches/main/protection")) return response({
      required_status_checks: { strict: true,
        contexts: ["CI", "Symphony Independent Review"],
        checks: [{ context: "Symphony Independent Review", app_id: 42 }] },
      enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    })
    if (url.includes("/pulls/16/reviews?")) return response([
      { id: 1, user: { login: "reviewer" }, state: "CHANGES_REQUESTED" },
      { id: 2, user: { login: "reviewer" }, state: "APPROVED" },
    ])
    if (url.endsWith("/graphql")) return response({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false } },
    } } } })
    if (url.includes("/rulesets?")) return response([])
    if (url.endsWith(`/statuses/${head}`)) return response({ id: 1 })
    if (url.includes(`/compare/${base}...${head}`)) return response({ files: [
      { filename: "services/agent-control/src/independent_review.ts" }] })
    if (url.includes("/contents/AGENTS.md?")) return response({
      encoding: "base64", content: btoa("root rules") })
    if (url.includes("/contents/services/agent-control/AGENTS.md?")) return response({
      encoding: "base64", content: btoa("service rules") })
    if (url.includes("/contents/")) return new Response("missing", { status: 404 })
    return new Response("missing", { status: 404 })
  }, "review-token", "review-publisher", 42)
  const subject = await gateway.loadSubject("thedoughmonster/momi-symphony", 16)
  assert.equal(subject.headSha, head)
  assert.equal(subject.baseSha, base)
  assert.deepEqual(subject.changedPaths, [
    "services/agent-control/src/independent_review.ts", "supabase/migrations/next.sql"])
  assert.equal(subject.diffArtifactRef,
    `https://api.github.com/repos/${subject.repository}/compare/${base}...${head}`)
  const rules = await gateway.loadApplicableRules(subject.repository, head, subject.changedPaths)
  assert.deepEqual(rules.map((rule) => rule.path),
    ["AGENTS.md", "services/agent-control/AGENTS.md"])
  assert.equal(rules.every((rule) => /^fnv1a64:[0-9a-f]{16}$/.test(rule.fingerprint)), true)
  const facts = await gateway.loadMergeFacts(subject.repository, "main", 16, head)
  assert.equal(facts.baseHeadSha, base)
  assert.equal(facts.requiredCi.conclusion, "success")
  assert.equal(facts.reviewCheck.conclusion, "success")
  assert.equal(facts.reviewCheckRequired, true)
  assert.equal(facts.bypassPossible, false)
  assert.equal(facts.authoritativeBlockingThreads, 0)
  assert.equal(facts.authoritativeChangesRequested, false)
  assert.equal((await gateway.loadHeadChecks(subject.repository, head))
    .some((check) => check.name === "CI" && check.conclusion === "success"), true)
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
    if (url.endsWith("/branches/main")) return response({ commit: { sha: base } })
    if (url.endsWith("/branches/main/protection")) return response({
      required_status_checks: { contexts: [] }, enforce_admins: { enabled: false } })
    if (url.includes("/pulls/16/reviews?")) return response([])
    return new Response("forbidden", { status: 403 })
  }, "review-token", "review-publisher", 42)
  const facts = await gateway.loadMergeFacts("thedoughmonster/momi-symphony", "main", 16, head)
  assert.equal(facts.authoritativeBlockingThreads, -1)
  assert.equal(facts.requiredCi.conclusion, "unknown")
  assert.equal(facts.reviewCheckRequired, false)
  assert.equal(facts.bypassPossible, true)
})

test("missing required CI and enabled bypasses fail closed", async () => {
  const gateway = new GitHubReviewGateway(async (input) => {
    const url = String(input)
    if (url.endsWith(`/commits/${head}/check-runs`)) return response({ check_runs: [
      { name: "CI", conclusion: "success" },
    ] })
    if (url.endsWith(`/commits/${head}/statuses`)) return response([
      { context: "Symphony Independent Review", state: "success",
        creator: { login: "review-publisher" } },
    ])
    if (url.endsWith("/branches/main")) return response({ commit: { sha: base } })
    if (url.endsWith("/branches/main/protection")) return response({
      required_status_checks: { contexts: ["CI", "lint", "Symphony Independent Review"] },
      enforce_admins: { enabled: true }, allow_force_pushes: { enabled: true },
      allow_deletions: { enabled: false },
    })
    if (url.includes("/pulls/16/reviews?")) return response([])
    if (url.endsWith("/graphql")) return response({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } })
    if (url.includes("/rulesets?")) return response([])
    return new Response("missing", { status: 404 })
  }, "review-token", "review-publisher", 42)
  const facts = await gateway.loadMergeFacts("thedoughmonster/momi-symphony", "main", 16, head)
  assert.equal(facts.requiredCi.conclusion, "unknown")
  assert.equal(facts.bypassPossible, true)
})

test("latest same-context success replaces stale failure and bypass actors are authoritative", async () => {
  const gateway = new GitHubReviewGateway(async (input) => {
    const url = String(input)
    if (url.endsWith(`/commits/${head}/check-runs`)) return response({ check_runs: [
      { id: 1, name: "CI", conclusion: "failure", completed_at: "2026-08-20T10:00:00Z" },
      { id: 2, name: "CI", conclusion: "success", completed_at: "2026-08-20T11:00:00Z" },
    ] })
    if (url.endsWith(`/commits/${head}/statuses`)) return response([
      { id: 3, context: "Symphony Independent Review", state: "failure",
        created_at: "2026-08-20T10:00:00Z", creator: { login: "review-publisher" } },
      { id: 4, context: "Symphony Independent Review", state: "success",
        created_at: "2026-08-20T11:00:00Z", creator: { login: "review-publisher" } },
    ])
    if (url.endsWith("/branches/main")) return response({ commit: { sha: base } })
    if (url.endsWith("/branches/main/protection")) return response({
      required_status_checks: { contexts: ["CI", "Symphony Independent Review"] },
      required_pull_request_reviews: { bypass_pull_request_allowances: {
        users: [{ login: "implementation" }], teams: [], apps: [],
      } }, enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
    })
    if (url.includes("/pulls/16/reviews?")) return response([])
    if (url.endsWith("/graphql")) return response({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } })
    if (url.includes("/rulesets?")) return response([])
    return new Response("missing", { status: 404 })
  }, "review-token", "review-publisher", 42)
  const facts = await gateway.loadMergeFacts("thedoughmonster/momi-symphony", "main", 16, head)
  assert.equal(facts.requiredCi.conclusion, "success")
  assert.equal(facts.reviewCheck.conclusion, "success")
  assert.equal(facts.bypassPossible, true)
})
