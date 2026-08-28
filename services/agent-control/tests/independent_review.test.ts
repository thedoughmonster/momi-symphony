import assert from "node:assert/strict"
import test from "node:test"

import { buildBoundedReviewerPacket, independentReviewRequirement, reduceMergeEligibility,
  requiresFreshReviewer,
  reviewExecutionBudget, reviewExecutionProfile, reviewRiskDimensions, REVIEW_CHECK_NAME,
  REVIEW_POLICY_VERSION, validateReviewReceipt,
  type CurrentReviewAuthority, type MergeGateEvidence, type ReviewReceipt,
  type ReviewSubject } from "../src/independent_review.ts"

const head = "a".repeat(40)
const base = "b".repeat(40)
const implementationId = "00000000-0000-4000-8000-000000000001"
const reviewerId = "00000000-0000-4000-8000-000000000002"
const subject: ReviewSubject = { implementation_dispatch_id: implementationId,
  reviewer_dispatch_id: reviewerId, repository: "thedoughmonster/momi-symphony",
  pull_request_number: 16, head_sha: head, base_sha: base, profile: "high",
  policy_version: REVIEW_POLICY_VERSION }
const receipt: ReviewReceipt = { ...subject, reviewer_identity: "independent_reviewer",
  reviewer_thread_id: "review-thread", reviewer_turn_id: "review-turn",
  result: "accepted", findings: [] }
const authority: CurrentReviewAuthority = { ...subject, review_attempt_id:
  "00000000-0000-4000-8000-000000000003", reviewer_identity: "independent_reviewer",
  reviewer_thread_id: "review-thread", reviewer_turn_id: "review-turn",
  state: "accepted", findings: [] }

function gate(overrides: Partial<MergeGateEvidence> = {}): MergeGateEvidence {
  return { lifecycle: "active", repository: subject.repository, base_branch: "main",
    pull_request: { exists: true, open: true, repository: subject.repository,
      pull_request_number: 16, base_branch: "main", head_sha: head, base_sha: base },
    required_ci: { head_sha: head, conclusion: "success" }, review: authority,
    review_check: { name: REVIEW_CHECK_NAME, head_sha: head, conclusion: "success" },
    authoritative_blocking_threads: 0, authoritative_changes_requested: false,
    branch_protection: { review_check_required: true, bypass_possible: false },
    independent_review_required: true,
    current_policy_version: REVIEW_POLICY_VERSION, expected_profile: "high", ...overrides }
}

test("bounded reviewer execution config remains readable for persisted profiles", () => {
  assert.deepEqual(reviewExecutionProfile("standard"),
    { model: "gpt-5.6-terra", reasoning_effort: "medium" })
  assert.equal(reviewExecutionBudget("high").model_turns, 16)
})

test("independent review is required only for the six named material boundaries", () => {
  assert.deepEqual(independentReviewRequirement([
    { path: "src/copy.ts", patch: "+export const message = 'hello'" },
  ]), { required: false, triggers: [], profile: null })
  const cases = [
    ["security_privacy", { path: "src/auth/session.ts", patch: "+rotateToken()" }],
    ["destructive_migration", { path: "supabase/migrations/x.sql",
      patch: "+alter table accounts drop column legacy" }],
    ["public_contract", { path: "contracts/input.schema.json", patch: "+{}" }],
    ["production_exposure_cost", { path: "ops/config.ts",
      patch: "+const productionCostLimit = 100" }],
    ["concurrency_state_integrity", { path: "src/queue.ts",
      patch: "+await advisory_lock()" }],
  ] as const
  for (const [trigger, file] of cases) {
    assert.deepEqual(independentReviewRequirement([file]).triggers, [trigger])
  }
  assert.deepEqual(independentReviewRequirement([{ path: "docs/readme.md", patch: "+safe" }],
    { labels: ["Independent Review Required"] }).triggers, ["explicit_owner_request"])
  assert.equal(independentReviewRequirement([
    { path: "supabase/migrations/x.sql", patch: "+create table safe_addition(id uuid)" },
  ]).required, false)
  assert.equal(independentReviewRequirement([
    { path: "src/unknown.ts", patch: null },
  ]).required, false)
  assert.equal(independentReviewRequirement([
    { path: "docs/scheduler.md", patch: "+Explain quarantine and token budgets." },
  ]).required, false)
})

test("strict reviewer result rejects self review, stale subjects, and blockers", () => {
  assert.equal(validateReviewReceipt(receipt, subject, "implementation-thread"), receipt)
  assert.throws(() => validateReviewReceipt({ ...receipt,
    reviewer_thread_id: "implementation-thread" }, subject, "implementation-thread"),
  /review_result_malformed/)
  assert.throws(() => validateReviewReceipt({ ...receipt, head_sha: "d".repeat(40) },
    subject, "implementation-thread"), /review_subject_mismatch:head_sha/)
  assert.throws(() => validateReviewReceipt({ ...receipt, model: "gpt-5.6-sol" },
    subject, "implementation-thread"), /review_result_malformed/)
  assert.throws(() => validateReviewReceipt({ ...receipt, findings: [{ id: "block-1",
    severity: "blocking", category: "correctness", path: "src/a.ts", line: 1,
    contract: "fail closed", required_outcome: "reject", evidence: "accepted" }] },
  subject, "implementation-thread"), /review_acceptance_has_blockers/)
})

test("one compact merge reducer fails closed for every missing current fact", () => {
  assert.deepEqual(reduceMergeEligibility(gate()), { eligible: true })
  const cases: Array<[string, MergeGateEvidence]> = [
    ["lifecycle_canceled", gate({ lifecycle: "canceled" })],
    ["review_not_accepted", gate({ review: null })],
    ["review_subject_stale_or_invalid", gate({ review: { ...authority,
      head_sha: "d".repeat(40) } })],
    ["required_ci_not_green", gate({ required_ci: { head_sha: head,
      conclusion: "pending" } })],
    ["review_check_not_green", gate({ review_check: { name: REVIEW_CHECK_NAME,
      head_sha: head, conclusion: "failure" } })],
    ["blocking_review_thread", gate({ authoritative_blocking_threads: 1 })],
    ["changes_requested", gate({ authoritative_changes_requested: true })],
    ["review_check_not_required", gate({ branch_protection: {
      review_check_required: false, bypass_possible: false } })],
    ["branch_protection_bypass_possible", gate({ branch_protection: {
      review_check_required: true, bypass_possible: true } })],
  ]
  for (const [reason, evidence] of cases) {
    assert.deepEqual(reduceMergeEligibility(evidence), { eligible: false, reason })
  }
  assert.deepEqual(reduceMergeEligibility(gate({ independent_review_required: false,
    review: null })), { eligible: true })
})

test("same reviewer correction uses complete diff, finding paths, and unchanged risk", () => {
  const common = { previousBaseSha: base, nextBaseSha: base,
    previousPolicyVersion: REVIEW_POLICY_VERSION, nextPolicyVersion: REVIEW_POLICY_VERSION,
    previousProfile: "high" as const, nextProfile: "high" as const,
    priorReviewerAvailable: true, completeDiff: true, changedPaths: ["src/a.ts"],
    findingPaths: ["src/a.ts"], previousRiskDimensions: ["architecture" as const],
    correctionRiskDimensions: ["architecture" as const] }
  assert.equal(requiresFreshReviewer(common), false)
  assert.equal(requiresFreshReviewer({ ...common, completeDiff: false }), true)
  assert.equal(requiresFreshReviewer({ ...common, changedPaths: ["src/b.ts"] }), true)
  assert.equal(requiresFreshReviewer({ ...common, nextBaseSha: "c".repeat(40) }), true)
  assert.equal(requiresFreshReviewer({ ...common,
    correctionRiskDimensions: ["security_auth"] }), true)
})

test("review packet carries exact subject and bounded current evidence only", () => {
  const packet = buildBoundedReviewerPacket({ subject, issue: { identifier: "MOX-260",
    title: "Independent review", required_outcome: "Review every implementation PR." },
    applicable_rule_paths: ["AGENTS.md"], changed_paths: ["src/b.ts", "src/a.ts"],
    diff_artifact_ref: "github://pr/16.diff",
    ci: [{ name: "CI", conclusion: "success", head_sha: head },
      { name: "old", conclusion: "success", head_sha: "d".repeat(40) }],
    correction: { previous_head_sha: "c".repeat(40),
      complete_diff_artifact_ref: `github://compare/${"c".repeat(40)}...${head}` } })
  assert.deepEqual(packet.changed_paths, ["src/a.ts", "src/b.ts"])
  assert.equal((packet.ci as unknown[]).length, 1)
  assert.equal("implementation_transcript" in packet, false)
  assert.equal("reviewer_transcript" in packet, false)
})
