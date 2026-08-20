import { stableFingerprint } from "./execution_efficiency.ts"

export const REVIEW_POLICY_VERSION = "independent-review-v1" as const
export const REVIEW_CHECK_NAME = "Symphony Independent Review" as const
export const REVIEW_FINDING_ID_PATTERN =
  "^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$" as const
export const REVIEW_FINDING_PATH_PATTERN =
  "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).{1,500}$" as const

export type ReviewProfile = "low" | "standard" | "high"
export type ReviewModel = "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol"
export type ReviewReasoningEffort = "low" | "medium" | "high"
export type ReviewExecutionBudget = { model_turns: number; no_progress_cycles: number;
  subagents: number; subagent_depth: number; model_visible_tool_bytes: number; elapsed_ms: number }
export type ReviewResult = "accepted" | "changes_requested" | "inconclusive" | "escalate"
export type ReviewRiskDimension = "architecture" | "security_auth" | "public_contract" |
  "schema_migration" | "concurrency" | "scheduler_recovery_cancellation" |
  "release_credential" | "runtime_network" | "general" | "ambiguous"

export type ReviewCorrectionContext = { previous_head_sha: string; new_head_sha: string;
  delta_artifact_ref: string; changed_paths: string[];
  changed_hunks: ReviewChangedHunk[];
  risk_dimensions: ReviewRiskDimension[] }

export type ReviewChangedHunk = { path: string; old_start: number; old_end: number;
  new_start: number; new_end: number; changed_line_count: number;
  changed_line_anchors: number[] }

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
  model: ReviewModel
  reasoning_effort: ReviewReasoningEffort
  budget_fingerprint: string
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
  /(?:^|\/)AGENTS(?:\.override)?\.md$/,
]
const lowRisk = [/\.md$/i, /(?:^|\/)docs?\//i]

/** Risk selection is deterministic. Missing, ambiguous, or material patch evidence promotes. */
export function selectReviewProfile(paths: string[],
  riskDimensions: ReviewRiskDimension[]): ReviewProfile {
  if (paths.length === 0 || paths.some((path) => !validRepositoryPath(path)) ||
    riskDimensions.length === 0 || riskDimensions.includes("ambiguous")) return "high"
  if (riskDimensions.some((dimension) => dimension !== "general")) return "high"
  if (paths.some((path) => highRisk.some((pattern) => pattern.test(path)))) return "high"
  if (paths.every((path) => lowRisk.some((pattern) => pattern.test(path)))) return "low"
  return "standard"
}

/** Reviewer execution is deterministic, increasing model capability, reasoning, and budget. */
export function reviewExecutionProfile(profile: ReviewProfile): {
  model: ReviewModel; reasoning_effort: ReviewReasoningEffort
} {
  if (profile === "low") return { model: "gpt-5.6-luna", reasoning_effort: "low" }
  if (profile === "standard") return { model: "gpt-5.6-terra", reasoning_effort: "medium" }
  return { model: "gpt-5.6-sol", reasoning_effort: "high" }
}

export function reviewExecutionBudget(profile: ReviewProfile): ReviewExecutionBudget {
  if (profile === "low") return { model_turns: 4, no_progress_cycles: 1, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 24_000, elapsed_ms: 900_000 }
  if (profile === "standard") return { model_turns: 8, no_progress_cycles: 2, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 48_000, elapsed_ms: 1_800_000 }
  return { model_turns: 16, no_progress_cycles: 2, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 96_000, elapsed_ms: 3_600_000 }
}

/** Stable proof that the trusted launch and callback used the exact profile budget. */
export function reviewBudgetFingerprint(profile: ReviewProfile): string {
  return stableFingerprint(reviewExecutionBudget(profile))
}

/** Deterministic material-risk dimensions; missing patch authority promotes to ambiguous. */
export function reviewRiskDimensions(files: Array<{ path: string; patch?: string | null }> |
  string[]): ReviewRiskDimension[] {
  const normalized = files.map((file) => typeof file === "string"
    ? { path: file, patch: "" } : file)
  if (normalized.length === 0 || normalized.some((file) =>
    !validRepositoryPath(file.path) || file.patch === null)) return ["ambiguous"]
  const dimensions = new Set<ReviewRiskDimension>()
  for (const file of normalized) {
    const evidence = `${file.path}\n${file.patch ?? ""}`
    if (/agent-control|architecture|dispatch|lifecycle|review|authority/i.test(evidence)) {
      dimensions.add("architecture")
    }
    if (/auth|security|permission|token|secret|identity|attest/i.test(evidence)) {
      dimensions.add("security_auth")
    }
    if (/contract|schema\.json|public|api\b|webhook/i.test(evidence)) {
      dimensions.add("public_contract")
    }
    if (/migration|schema|database|postgres|sql\b|momi_agent_ops/i.test(evidence)) {
      dimensions.add("schema_migration")
    }
    if (/concurr|lock|race|atomic|lease|fenc/i.test(evidence)) dimensions.add("concurrency")
    if (/scheduler|recovery|recover|cancel|stale|supersed/i.test(evidence)) {
      dimensions.add("scheduler_recovery_cancellation")
    }
    if (/release|deploy|credential|branch.protection|status.check/i.test(evidence)) {
      dimensions.add("release_credential")
    }
    if (/runtime|network|fetch\b|host|sandbox|workspace|thread|turn/i.test(evidence)) {
      dimensions.add("runtime_network")
    }
  }
  if (dimensions.size === 0) dimensions.add("general")
  return [...dimensions].sort()
}

export function validateReviewReceipt(value: unknown, subject: ReviewSubject,
  implementationThreadId: string): ReviewReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("review_result_malformed")
  }
  const receipt = value as ReviewReceipt
  const expectedKeys = ["artifact_ref", "base_sha", "findings", "generation", "head_sha",
    "budget_fingerprint", "implementation_dispatch_id", "model", "policy_version", "profile",
    "pull_request_number",
    "reasoning_effort",
    "repository", "result", "result_fingerprint", "reviewer_dispatch_id",
    "reviewer_thread_id", "reviewer_turn_id", "runtime_role"].sort().join(",")
  if (Object.keys(receipt).sort().join(",") !== expectedKeys ||
    receipt.runtime_role !== "independent_reviewer" ||
    receipt.reviewer_thread_id === implementationThreadId ||
    !["accepted", "changes_requested", "inconclusive", "escalate"].includes(receipt.result) ||
    !Array.isArray(receipt.findings) || receipt.findings.length > 100 ||
    !receipt.findings.every(validReviewFinding) ||
    !receipt.artifact_ref || receipt.artifact_ref.length > 500 ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.result_fingerprint)) {
    throw new Error("review_result_malformed")
  }
  for (const key of ["implementation_dispatch_id", "reviewer_dispatch_id", "repository",
    "pull_request_number", "head_sha", "base_sha", "generation", "profile",
    "model", "reasoning_effort", "budget_fingerprint", "policy_version"] as const) {
    if (receipt[key] !== subject[key]) throw new Error(`review_subject_mismatch:${key}`)
  }
  const execution = reviewExecutionProfile(receipt.profile)
  if (receipt.model !== execution.model || receipt.reasoning_effort !== execution.reasoning_effort) {
    throw new Error("review_execution_profile_mismatch")
  }
  if (receipt.budget_fingerprint !== reviewBudgetFingerprint(receipt.profile)) {
    throw new Error("review_execution_budget_mismatch")
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
    receipt.model !== reviewExecutionProfile(evidence.expected_profile).model ||
    receipt.reasoning_effort !== reviewExecutionProfile(evidence.expected_profile).reasoning_effort ||
    receipt.budget_fingerprint !== reviewBudgetFingerprint(evidence.expected_profile) ||
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

/**
 * Same-review correction is permitted only when the exact delta stays on active finding paths
 * and reviewer availability, policy, and deterministic risk profile are unchanged. Finding
 * prose/category is not evidence that the correction itself broadened risk.
 */
export function requiresFreshReviewer(input: {
  previousProfile: ReviewProfile
  nextProfile: ReviewProfile
  priorReviewerAvailable: boolean
  policyChanged: boolean
  subjectChanged: boolean
  rulesChanged: boolean
  changedPaths: string[]
  findings: Array<{ path: string; line: number | null }>
  changedHunks: ReviewChangedHunk[]
  previousRiskDimensions: ReviewRiskDimension[]
  correctionRiskDimensions: ReviewRiskDimension[]
}): boolean {
  if (!input.priorReviewerAvailable || input.policyChanged ||
    input.subjectChanged || input.rulesChanged || input.previousProfile !== input.nextProfile ||
    input.correctionRiskDimensions.includes("ambiguous") ||
    input.correctionRiskDimensions.some((dimension) =>
      !input.previousRiskDimensions.includes(dimension))) return true
  const findingPaths = new Set(input.findings.map((finding) => finding.path))
  const hunkPaths = new Set(input.changedHunks.map((hunk) => hunk.path))
  if (input.changedPaths.length === 0 || input.changedHunks.length === 0 ||
    input.changedHunks.length > 12 ||
    input.changedHunks.reduce((total, hunk) => total + hunk.changed_line_count, 0) > 24 ||
    input.changedPaths.some((path) => !findingPaths.has(path) || !hunkPaths.has(path)) ||
    input.changedHunks.some((hunk) => !input.changedPaths.includes(hunk.path))) return true
  return input.changedHunks.some((hunk) => hunk.changed_line_count < 1 ||
    hunk.changed_line_count > 12 ||
    hunk.changed_line_anchors.length !== hunk.changed_line_count ||
    hunk.changed_line_anchors.some((anchor) => !input.findings.some((finding) =>
      finding.path === hunk.path && finding.line !== null &&
      Math.abs(finding.line - anchor) <= 3)))
}

export function buildBoundedReviewerPacket(input: {
  subject: ReviewSubject
  issue: { identifier: string; title: string; required_outcome: string }
  applicable_rules: Array<{ path: string; fingerprint: string }>
  changed_paths: string[]
  diff_artifact_ref: string
  ci: Array<{ name: string; conclusion: string; head_sha: string }>
  unresolved_findings?: Array<Pick<ReviewFinding, "id" | "path" | "line" | "required_outcome">>
  correction_context?: ReviewCorrectionContext
}): Record<string, unknown> {
  if (input.changed_paths.length === 0 || input.changed_paths.length > 500 ||
    input.changed_paths.some((path) => !validRepositoryPath(path)) ||
    !input.diff_artifact_ref || !input.issue.title || !input.issue.required_outcome ||
    input.issue.required_outcome.length > 8_000) {
    throw new Error("review_packet_invalid")
  }
  const packet = { schema_version: 1, subject: input.subject, issue: input.issue,
    applicable_rules: input.applicable_rules, changed_paths: [...input.changed_paths].sort(),
    diff_artifact_ref: input.diff_artifact_ref,
    ci: input.ci.filter((check) => check.head_sha === input.subject.head_sha),
    unresolved_findings: input.unresolved_findings ?? [],
    ...(input.correction_context ? { correction_context: input.correction_context } : {}) }
  if (JSON.stringify(packet).length > 6_500) throw new Error("review_packet_prompt_too_large")
  return packet
}

export function validReviewFinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const finding = value as ReviewFinding
  const keys = ["category", "contract", "evidence", "id", "line", "path",
    "required_outcome", "severity"]
  return Object.keys(finding).sort().join(",") === keys.join(",") &&
    typeof finding.id === "string" &&
    new RegExp(REVIEW_FINDING_ID_PATTERN).test(finding.id) &&
    ["blocking", "nonblocking"].includes(finding.severity) &&
    typeof finding.category === "string" && finding.category.length <= 120 &&
    validRepositoryPath(finding.path) &&
    (finding.line === null || (Number.isSafeInteger(finding.line) && finding.line! > 0)) &&
    [finding.contract, finding.required_outcome, finding.evidence].every((text) =>
      typeof text === "string" && text.length > 0 && text.length <= 2_000)
}

function validRepositoryPath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && path.length <= 500 &&
    new RegExp(REVIEW_FINDING_PATH_PATTERN).test(path)
}

function denied(reason: string): MergeGateDecision { return { eligible: false, reason } }
