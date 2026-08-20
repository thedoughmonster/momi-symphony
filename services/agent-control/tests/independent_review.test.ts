import assert from "node:assert/strict"
import test from "node:test"

import { buildBoundedReviewerPacket, reduceMergeEligibility, requiresFreshReviewer,
  REVIEW_CHECK_NAME, REVIEW_POLICY_VERSION, selectReviewProfile,
  validateReviewReceipt, type MergeGateEvidence, type ReviewReceipt,
  type ReviewSubject } from "../src/independent_review.ts"

const head = "a".repeat(40)
const base = "b".repeat(40)
const subject: ReviewSubject = {
  implementation_dispatch_id: "00000000-0000-4000-8000-000000000001",
  reviewer_dispatch_id: "00000000-0000-4000-8000-000000000002",
  repository: "thedoughmonster/momi-symphony", pull_request_number: 16,
  head_sha: head, base_sha: base, generation: 1, profile: "high",
  policy_version: REVIEW_POLICY_VERSION,
}
const receipt: ReviewReceipt = { ...subject, reviewer_thread_id: "review-thread",
  reviewer_turn_id: "review-turn", runtime_role: "independent_reviewer",
  result: "accepted", findings: [], artifact_ref: "review://attempt/1",
  result_fingerprint: `sha256:${"c".repeat(64)}` }

function gate(overrides: Partial<MergeGateEvidence> = {}): MergeGateEvidence {
  return { lifecycle: "active", repository: subject.repository, base_branch: "main",
    pull_request: { exists: true, open: true, repository: subject.repository,
      base_branch: "main", head_sha: head, base_sha: base },
    required_ci: { head_sha: head, conclusion: "success" }, review: receipt,
    review_check: { name: REVIEW_CHECK_NAME, head_sha: head, conclusion: "success" },
    authoritative_blocking_threads: 0, authoritative_changes_requested: false,
    branch_protection: { review_check_required: true, bypass_possible: false },
    current_policy_version: REVIEW_POLICY_VERSION, expected_profile: "high",
    implementation_thread_id: "implementation-thread", ...overrides }
}

test("risk routing promotes sensitive and ambiguous surfaces", () => {
  assert.equal(selectReviewProfile(["docs/operator.md"]), "low")
  assert.equal(selectReviewProfile(["services/decision-alert-delivery/src/a.ts"]), "standard")
  assert.equal(selectReviewProfile(["supabase/migrations/next.sql"]), "high")
  assert.equal(selectReviewProfile(["services/agent-control/src/x.ts"]), "high")
  assert.equal(selectReviewProfile([]), "high")
  assert.equal(selectReviewProfile(["../outside"]), "high")
})

test("receipt validation rejects author identity, stale subject, malformed output, and blockers", () => {
  assert.equal(validateReviewReceipt(receipt, subject, "implementation-thread"), receipt)
  assert.throws(() => validateReviewReceipt({ ...receipt,
    reviewer_thread_id: "implementation-thread" }, subject, "implementation-thread"),
  /review_result_malformed/)
  assert.throws(() => validateReviewReceipt({ ...receipt, head_sha: "d".repeat(40) },
    subject, "implementation-thread"), /review_subject_mismatch:head_sha/)
  assert.throws(() => validateReviewReceipt({ ...receipt, unexpected: true }, subject,
    "implementation-thread"), /review_result_malformed/)
  assert.throws(() => validateReviewReceipt({ ...receipt, findings: [{ id: "block-1",
    severity: "blocking", category: "correctness", path: "src/a.ts", line: 1,
    contract: "must fail closed", required_outcome: "reject unknown input",
    evidence: "unknown input currently returns success" }] }, subject,
  "implementation-thread"), /review_acceptance_has_blockers/)
})

test("exact-head merge reduction fails closed for every missing authority", () => {
  assert.deepEqual(reduceMergeEligibility(gate()), { eligible: true })
  const cases: Array<[string, MergeGateEvidence]> = [
    ["lifecycle_canceled", gate({ lifecycle: "canceled" })],
    ["review_not_accepted", gate({ review: null })],
    ["review_subject_stale_or_invalid", gate({ review: { ...receipt,
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
})

test("same reviewer may verify only a mechanically bounded correction", () => {
  const common = { previousProfile: "high" as const, nextProfile: "high" as const,
    priorReviewerAvailable: true, policyChanged: false, materialRiskChanged: false,
    findingPaths: ["src/a.ts"] }
  assert.equal(requiresFreshReviewer({ ...common, changedPaths: ["src/a.ts"] }), false)
  assert.equal(requiresFreshReviewer({ ...common, changedPaths: ["src/a.ts", "src/b.ts"] }), true)
  assert.equal(requiresFreshReviewer({ ...common, changedPaths: ["src/a.ts"],
    policyChanged: true }), true)
})

test("review packets include only exact bounded sources", () => {
  const packet = buildBoundedReviewerPacket({ subject, issue: { identifier: "MOX-260",
    title: "Independent review", required_outcome: "Review every implementation PR." },
    applicable_rules: [{ path: "AGENTS.md", fingerprint: "fnv1a64:1" }],
    changed_paths: ["src/b.ts", "src/a.ts"], diff_artifact_ref: "github://pr/16.diff",
    ci: [{ name: "CI", conclusion: "success", head_sha: head },
      { name: "other", conclusion: "success", head_sha: "d".repeat(40) }] })
  assert.deepEqual(packet.changed_paths, ["src/a.ts", "src/b.ts"])
  assert.equal((packet.ci as unknown[]).length, 1)
  assert.equal("implementation_transcript" in packet, false)
  assert.equal("reviewer_transcript" in packet, false)
  assert.throws(() => buildBoundedReviewerPacket({ subject, issue: {
    identifier: "MOX-260", title: "Independent review", required_outcome: "bounded" },
    applicable_rules: [{ path: "AGENTS.md", fingerprint: "fnv1a64:1" }],
    changed_paths: Array.from({ length: 200 }, (_, index) =>
      `services/agent-control/src/very-long-review-path-${index.toString().padStart(3, "0")}.ts`),
    diff_artifact_ref: "github://compare/exact", ci: [] }), /prompt_too_large/)
})
