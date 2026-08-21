import assert from "node:assert/strict"
import test from "node:test"

import { GitHubReviewGateway } from "../src/github_review_gateway.ts"

const head = "a".repeat(40)
const base = "b".repeat(40)
const previous = "c".repeat(40)
const repository = "thedoughmonster/momi-symphony"
function response(value: unknown): Response { return Response.json(value) }

test("complete diff evidence drives correction risk and truncation fails closed", async () => {
  const patch = ["@@ -1 +1 @@", "-old", "+new"].join("\n")
  const comparison = (changes: number, mergeBase = previous) => ({ status: "ahead", ahead_by: 1,
    merge_base_commit: { sha: mergeBase }, files: [{ filename: "src/feature.ts",
      additions: changes - 1, deletions: 1, changes, patch }] })
  const complete = new GitHubReviewGateway(async () => response(comparison(2)),
    "review-token", "review-publisher", 42)
  assert.deepEqual(await complete.loadCorrectionDelta(repository, previous, head), {
    changedPaths: ["src/feature.ts"], complete: true, riskDimensions: ["general"],
    diffArtifactRef: `https://api.github.com/repos/${repository}/compare/${previous}...${head}` })
  const truncated = new GitHubReviewGateway(async () => response(comparison(4)),
    "review-token", "review-publisher", 42)
  assert.equal((await truncated.loadCorrectionDelta(repository, previous, head)).complete, false)
  const unrelated = new GitHubReviewGateway(async () => response(comparison(2, base)),
    "review-token", "review-publisher", 42)
  assert.equal((await unrelated.loadCorrectionDelta(repository, previous, head)).complete, false)
})

test("gateway freezes exact subject and reads only protected-base rules", async () => {
  const calls: string[] = []
  const patch = ["@@ -1 +1 @@", "-old", "+new"].join("\n")
  const gateway = new GitHubReviewGateway(async (input) => {
    const url = String(input); calls.push(url)
    if (url.endsWith("/pulls/16")) return response({ state: "open",
      head: { sha: head }, base: { sha: base, ref: "main" } })
    if (url.includes("/pulls/16/files")) return response([{ filename:
      "services/agent-control/src/independent_review.ts", additions: 1, deletions: 1,
      changes: 2, patch }])
    if (url.includes("/contents/AGENTS.md?") && url.endsWith(`ref=${base}`)) {
      return response({ encoding: "base64", content: btoa("protected root rules") })
    }
    if (url.includes("/contents/services/agent-control/AGENTS.md?") &&
      url.endsWith(`ref=${base}`)) {
      return response({ encoding: "base64", content: btoa("protected service rules") })
    }
    return new Response("missing", { status: 404 })
  }, "review-token", "review-publisher", 42)
  const subject = await gateway.loadSubject(repository, 16)
  assert.equal(subject.headSha, head)
  assert.equal(subject.baseSha, base)
  assert.equal(subject.riskDimensions.includes("ambiguous"), false)
  const rules = await gateway.loadApplicableRules(repository, base, subject.changedPaths)
  assert.deepEqual(rules.map((rule) => rule.path),
    ["AGENTS.md", "services/agent-control/AGENTS.md"])
  assert.equal(calls.some((url) => url.includes("/contents/") && url.endsWith(`ref=${head}`)), false)
})

test("projection is deterministic and updates the owned exact-head check idempotently", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const externalId = `symphony-review:${repository}#${head}`
  const gateway = new GitHubReviewGateway(async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url.includes(`/commits/${head}/check-runs?`)) return response({ check_runs: [{ id: 99,
      external_id: externalId, app: { id: 42, slug: "review-publisher" } }] })
    if (url.endsWith("/check-runs/99")) return response({ id: 99 })
    return new Response("missing", { status: 404 })
  }, "review-token", "review-publisher", 42)
  await gateway.projectReviewCheck(repository, head, "success", "accepted")
  const update = calls.find((call) => call.url.endsWith("/check-runs/99"))
  assert.equal(update?.init?.method, "PATCH")
  const body = JSON.parse(String(update?.init?.body))
  assert.equal(body.external_id, externalId)
  assert.equal(body.conclusion, "success")
})

test("merge facts and exact-SHA merge fail closed on blockers and bypass", async () => {
  const gateway = new GitHubReviewGateway(async (input, init) => {
    const url = String(input)
    if (url.endsWith(`/commits/${head}/check-runs`)) return response({ check_runs: [
      { name: "CI", conclusion: "success", app: { id: 77, slug: "ci" } },
      { name: "Symphony Independent Review", conclusion: "success",
        app: { id: 42, slug: "review-publisher" } }] })
    if (url.endsWith(`/commits/${head}/statuses`)) return response([])
    if (url.endsWith("/branches/main")) return response({ commit: { sha: base } })
    if (url.endsWith("/branches/main/protection")) return response({
      required_status_checks: { strict: true, contexts: ["CI", "Symphony Independent Review"],
        checks: [{ context: "CI", app_id: 77 },
          { context: "Symphony Independent Review", app_id: 42 }] },
      enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false } })
    if (url.includes("/pulls/16/reviews?")) return response([])
    if (url.endsWith("/graphql")) return response({ data: { repository: { pullRequest: {
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } })
    if (url.includes("/rulesets?")) return response([])
    if (url.endsWith("/pulls/16/merge") && init?.method === "PUT") {
      return response({ merged: true, sha: "d".repeat(40) })
    }
    return new Response("missing", { status: 404 })
  }, "review-token", "review-publisher", 42)
  const facts = await gateway.loadMergeFacts(repository, "main", 16, head)
  assert.equal(facts.requiredCi.conclusion, "success")
  assert.equal(facts.reviewCheckRequired, true)
  assert.equal(facts.bypassPossible, false)
  assert.deepEqual(await gateway.mergePullRequest(repository, 16, head),
    { merged: true, sha: "d".repeat(40) })
})
