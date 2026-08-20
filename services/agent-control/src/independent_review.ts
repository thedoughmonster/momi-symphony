export const REVIEW_POLICY_VERSION = "independent-review-v1" as const
export const REVIEW_CHECK_NAME = "Symphony Independent Review" as const

export type ReviewProfile = "low" | "standard" | "high"
export type ReviewResult = "accepted" | "changes_requested" | "inconclusive" | "escalate"

export type ReviewFinding = {
  id: string
  severity: "blocking" | "nonblocking"
  category: string
  path: string
  line: number | null
  contract: string
  required_outcome: string
  evidence: string
}

export type ReviewSubject = {
  implementation_dispatch_id: string
  reviewer_dispatch_id: string
  repository: string
  pull_request_number: number
  head_sha: string
  base_sha: string
  generation: number
  profile: ReviewProfile
  policy_version: typeof REVIEW_POLICY_VERSION
}

export type ReviewReceipt = ReviewSubject & {
  reviewer_thread_id: string
  reviewer_turn_id: string
  runtime_role: "independent_reviewer"
  result: ReviewResult
  findings: ReviewFinding[]
  artifact_ref: string
  result_fingerprint: string
}

export type MergeGateEvidence = {
  lifecycle: "active" | "canceled" | "ambiguous" | "terminal"
  repository: string
  base_branch: string
  pull_request: {
    exists: boolean
    open: boolean
    repository: string
    base_branch: string
    head_sha: string
    base_sha: string
  }
  required_ci: { head_sha: string; conclusion: "success" | "pending" | "failure" | "unknown" }
  review: ReviewReceipt | null
  review_check: { name: string; head_sha: string; conclusion: "success" | "pending" | "failure" | "unknown" }
  authoritative_blocking_threads: number
  authoritative_changes_requested: boolean
  branch_protection: { review_check_required: boolean; bypass_possible: boolean }
  current_policy_version: typeof REVIEW_POLICY_VERSION
  expected_profile: ReviewProfile
  implementation_thread_id: string
}

export type MergeGateDecision = { eligible: true } | {
  eligible: false
  reason: string
}

const highRisk = [
  /^\.github\//, /^supabase\/migrations\//, /(?:^|\/)(?:auth|security|credential|secret)/i,
  /(?:^|\/)(?:scheduler|recovery|cancellation|migration|database|persistence|network|runtime)/i,
  /^services\/agent-control(?:-host)?\//, /(?:^|\/)contracts?\//,
]
const lowRisk = [/\.md$/i, /(?:^|\/)docs?\//i]

/** Risk selection is deterministic. Unknown or mixed surfaces promote upward. */
export function selectReviewProfile(paths: string[]): ReviewProfile {
  if (paths.length === 0 || paths.some((path) => !validRepositoryPath(path))) return "high"
  if (paths.some((path) => highRisk.some((pattern) => pattern.test(path)))) return "high"
  if (paths.every((path) => lowRisk.some((pattern) => pattern.test(path)))) return "low"
  return "standard"
}

export function validateReviewReceipt(value: unknown, subject: ReviewSubject,
  implementationThreadId: string): ReviewReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("review_result_malformed")
  }
  const receipt = value as ReviewReceipt
  const expectedKeys = ["artifact_ref", "base_sha", "findings", "generation", "head_sha",
    "implementation_dispatch_id", "policy_version", "profile", "pull_request_number",
    "repository", "result", "result_fingerprint", "reviewer_dispatch_id",
    "reviewer_thread_id", "reviewer_turn_id", "runtime_role"].sort().join(",")
  if (Object.keys(receipt).sort().join(",") !== expectedKeys ||
    receipt.runtime_role !== "independent_reviewer" ||
    receipt.reviewer_thread_id === implementationThreadId ||
    !["accepted", "changes_requested", "inconclusive", "escalate"].includes(receipt.result) ||
    !Array.isArray(receipt.findings) || receipt.findings.length > 100 ||
    !receipt.findings.every(validFinding) ||
    !receipt.artifact_ref || receipt.artifact_ref.length > 500 ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.result_fingerprint)) {
    throw new Error("review_result_malformed")
  }
  for (const key of ["implementation_dispatch_id", "reviewer_dispatch_id", "repository",
    "pull_request_number", "head_sha", "base_sha", "generation", "profile",
    "policy_version"] as const) {
    if (receipt[key] !== subject[key]) throw new Error(`review_subject_mismatch:${key}`)
  }
  if (receipt.result === "accepted" && receipt.findings.some((finding) =>
    finding.severity === "blocking")) throw new Error("review_acceptance_has_blockers")
  return receipt
}

/** Pure, fail-closed exact-subject merge reducer. */
export function reduceMergeEligibility(evidence: MergeGateEvidence): MergeGateDecision {
  if (evidence.lifecycle !== "active") return denied(`lifecycle_${evidence.lifecycle}`)
  const pr = evidence.pull_request
  if (!pr.exists || !pr.open) return denied("pull_request_not_open")
  if (pr.repository !== evidence.repository || pr.base_branch !== evidence.base_branch) {
    return denied("pull_request_mapping_mismatch")
  }
  const receipt = evidence.review
  if (!receipt || receipt.result !== "accepted") return denied("review_not_accepted")
  if (receipt.repository !== pr.repository || receipt.pull_request_number < 1 ||
    receipt.head_sha !== pr.head_sha || receipt.base_sha !== pr.base_sha ||
    receipt.policy_version !== evidence.current_policy_version ||
    receipt.profile !== evidence.expected_profile ||
    receipt.runtime_role !== "independent_reviewer" ||
    receipt.reviewer_thread_id === evidence.implementation_thread_id) {
    return denied("review_subject_stale_or_invalid")
  }
  if (evidence.required_ci.head_sha !== pr.head_sha ||
    evidence.required_ci.conclusion !== "success") return denied("required_ci_not_green")
  if (evidence.review_check.name !== REVIEW_CHECK_NAME ||
    evidence.review_check.head_sha !== pr.head_sha ||
    evidence.review_check.conclusion !== "success") return denied("review_check_not_green")
  if (evidence.authoritative_blocking_threads < 0) return denied("review_threads_unknown")
  if (evidence.authoritative_blocking_threads > 0) return denied("blocking_review_thread")
  if (evidence.authoritative_changes_requested) return denied("changes_requested")
  if (!evidence.branch_protection.review_check_required) return denied("review_check_not_required")
  if (evidence.branch_protection.bypass_possible) return denied("branch_protection_bypass_possible")
  return { eligible: true }
}

/** Same-review correction is permitted only for an exact, mechanically bounded finding fix. */
export function requiresFreshReviewer(input: {
  previousProfile: ReviewProfile
  nextProfile: ReviewProfile
  priorReviewerAvailable: boolean
  policyChanged: boolean
  changedPaths: string[]
  findingPaths: string[]
  materialRiskChanged: boolean
}): boolean {
  if (!input.priorReviewerAvailable || input.policyChanged || input.materialRiskChanged ||
    input.previousProfile !== input.nextProfile) return true
  const bounded = new Set(input.findingPaths)
  return input.changedPaths.length === 0 || input.changedPaths.some((path) => !bounded.has(path))
}

export function buildBoundedReviewerPacket(input: {
  subject: ReviewSubject
  issue: { identifier: string; title: string; required_outcome: string }
  applicable_rules: Array<{ path: string; fingerprint: string }>
  changed_paths: string[]
  diff_artifact_ref: string
  ci: Array<{ name: string; conclusion: string; head_sha: string }>
  unresolved_findings?: Array<Pick<ReviewFinding, "id" | "path" | "line" | "required_outcome">>
}): Record<string, unknown> {
  if (input.changed_paths.length === 0 || input.changed_paths.length > 500 ||
    input.changed_paths.some((path) => !validRepositoryPath(path)) ||
    !input.diff_artifact_ref || input.issue.required_outcome.length > 8_000) {
    throw new Error("review_packet_invalid")
  }
  return { schema_version: 1, subject: input.subject, issue: input.issue,
    applicable_rules: input.applicable_rules, changed_paths: [...input.changed_paths].sort(),
    diff_artifact_ref: input.diff_artifact_ref,
    ci: input.ci.filter((check) => check.head_sha === input.subject.head_sha),
    unresolved_findings: input.unresolved_findings ?? [] }
}

function validFinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const finding = value as ReviewFinding
  return /^[a-z0-9][a-z0-9._:-]{2,119}$/i.test(finding.id) &&
    ["blocking", "nonblocking"].includes(finding.severity) &&
    typeof finding.category === "string" && finding.category.length <= 120 &&
    validRepositoryPath(finding.path) &&
    (finding.line === null || (Number.isSafeInteger(finding.line) && finding.line! > 0)) &&
    [finding.contract, finding.required_outcome, finding.evidence].every((text) =>
      typeof text === "string" && text.length > 0 && text.length <= 2_000)
}

function validRepositoryPath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && path.length <= 500 &&
    !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\")
}

function denied(reason: string): MergeGateDecision { return { eligible: false, reason } }
