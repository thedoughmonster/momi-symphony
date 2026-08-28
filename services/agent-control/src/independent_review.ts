export const REVIEW_POLICY_VERSION = "risk-proportional-review-v3" as const
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
export type IndependentReviewTrigger = "security_privacy" | "destructive_migration" |
  "public_contract" | "production_exposure_cost" | "concurrency_state_integrity" |
  "workflow_ci_integrity" | "incomplete_diff_evidence" | "explicit_owner_request"
export type IndependentReviewRequirement = { required: boolean;
  triggers: IndependentReviewTrigger[]; profile: "high" | null }

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
  profile: ReviewProfile
  policy_version: typeof REVIEW_POLICY_VERSION
}

export type ReviewReceipt = ReviewSubject & {
  reviewer_identity: "independent_reviewer"
  reviewer_thread_id: string
  reviewer_turn_id: string
  result: ReviewResult
  findings: ReviewFinding[]
}

export type CurrentReviewAuthority = ReviewSubject & {
  review_attempt_id: string
  reviewer_identity: "independent_reviewer"
  reviewer_thread_id: string
  reviewer_turn_id: string
  state: "accepted"
  findings: ReviewFinding[]
}

export type MergeGateEvidence = {
  lifecycle: "active" | "canceled" | "terminal"
  repository: string
  base_branch: string
  pull_request: { exists: boolean; open: boolean; repository: string;
    pull_request_number: number; base_branch: string; head_sha: string; base_sha: string }
  required_ci: { head_sha: string; conclusion: "success" | "pending" | "failure" | "unknown" }
  review: CurrentReviewAuthority | null
  review_check: { name: string; head_sha: string;
    conclusion: "success" | "pending" | "failure" | "unknown" }
  authoritative_blocking_threads: number
  authoritative_changes_requested: boolean
  authoritative_approvals: number
  owned_validation: { state: string; head_sha: string | null }
  branch_protection: { review_check_required: boolean; bypass_possible: boolean }
  independent_review_required: boolean
  current_policy_version: typeof REVIEW_POLICY_VERSION
  expected_profile: ReviewProfile
}

export type MergeGateDecision = { eligible: true } | { eligible: false; reason: string }

const ownerReviewLabels = new Set(["independent-review", "independent review required"])
const lowRisk = [/\.md$/i, /(?:^|\/)docs?\//i]
const securitySensitivePath = /(?:^|\/)(?:auth(?:entication|orization|n|z)?|security|privacy|sessions?|permissions?|access[-_]?control|rbac|iam|identity|credentials?|secrets?|guards?)(?:[./_-]|\/|$)/i
const protectedCiPath = /^(?:\.github\/(?:workflows\/.+\.ya?ml|actions\/.+\/action\.ya?ml)|\.circleci\/config\.ya?ml|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|\.buildkite\/.+\.ya?ml)$/i

export function independentReviewRequirement(
  files: Array<{ path: string; patch?: string | null; evidenceComplete?: boolean;
    status?: string }> | string[],
  ownerRequest: { labels?: readonly string[]; description?: string | null } = {},
): IndependentReviewRequirement {
  const triggers = new Set<IndependentReviewTrigger>()
  const labels = (ownerRequest.labels ?? []).map((label) => label.trim().toLowerCase())
  const description = ownerRequest.description ?? ""
  if (labels.some((label) => ownerReviewLabels.has(label)) ||
    /(?:^|\n)independent review\s*:\s*required(?:\s|$)/i.test(description)) {
    triggers.add("explicit_owner_request")
  }
  if (files.length === 0) triggers.add("incomplete_diff_evidence")
  for (const entry of files) {
    const file = typeof entry === "string"
      ? { path: entry, patch: "", evidenceComplete: false, status: "" } : entry
    if (!validRepositoryPath(file.path) || !hasPatchEvidence(file.patch) ||
      file.evidenceComplete === false) triggers.add("incomplete_diff_evidence")
    if (!validRepositoryPath(file.path)) continue
    const additions = addedPatchLines(file.patch)
    const deletions = deletedPatchLines(file.patch)
    const changed = `${additions}\n${deletions}`
    const evidence = `${file.path}\n${changed}`
    const inspectContent = !lowRisk.some((pattern) => pattern.test(file.path))
    const deletionOnly = deletions.trim().length > 0 && additions.trim().length === 0
    const removedSensitiveGuard = deletionOnly &&
      /(?:\b(?:admin|role|permission|access|session|user|account|tenant|scope|claim|principal|identity|authenticated)\b|\b(?:is|has|can)[A-Z_][A-Za-z0-9_]*)/i.test(deletions)
    if (securitySensitivePath.test(file.path) || removedSensitiveGuard || (inspectContent &&
      /\b(?:authentication|authoriz(?:e|ed|ation)|privacy|pii|secret|credential|token)\b/i.test(
        changed))) triggers.add("security_privacy")
    if (/\bsupabase\/migrations\//i.test(file.path) &&
      (file.status === "removed" ||
      /\b(?:drop\s+(?:table|column|schema|type|function|index)|truncate|delete\s+from|alter\s+table[\s\S]{0,160}\bdrop\b)\b/i.test(
        additions))) triggers.add("destructive_migration")
    if (/(?:^|\/)contracts?(?:\/|$)|\.schema\.json$/i.test(file.path) ||
      (inspectContent &&
      /\b(?:public\s+(?:api|contract)|breaking\s+change|webhook\s+(?:schema|contract))\b/i.test(
        additions))) triggers.add("public_contract")
    if (inspectContent &&
      /(?:\bproduction(?:[A-Z_-]|\b)|\bprod(?:uction)?[-_ ]deploy\b|\b(?:billing|cost|spend|quota|rate limit|autoscal|exposure)\b)/i.test(
        evidence)) triggers.add("production_exposure_cost")
    if (protectedCiPath.test(file.path) && !provablySafeCiCommentChange(file.patch)) {
      triggers.add("workflow_ci_integrity")
    }
    if (inspectContent &&
      /\b(?:concurr|race|mutex|semaphore|advisory[_ ]lock|for update|atomic|lease|fenc|idempot|quarant|scheduler slot|state integrity|compare-and-set)\b/i.test(
        evidence)) triggers.add("concurrency_state_integrity")
  }
  const sorted = [...triggers].sort()
  return { required: sorted.length > 0, triggers: sorted,
    profile: sorted.length > 0 ? "high" : null }
}

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
  const expectedKeys = ["base_sha", "findings", "head_sha", "implementation_dispatch_id",
    "policy_version", "profile", "pull_request_number", "repository", "result",
    "reviewer_dispatch_id", "reviewer_identity", "reviewer_thread_id",
    "reviewer_turn_id"].sort().join(",")
  if (Object.keys(receipt).sort().join(",") !== expectedKeys ||
    receipt.reviewer_identity !== "independent_reviewer" ||
    receipt.reviewer_thread_id === implementationThreadId ||
    !["accepted", "changes_requested", "inconclusive", "escalate"].includes(receipt.result) ||
    !Array.isArray(receipt.findings) || receipt.findings.length > 100 ||
    !receipt.findings.every(validReviewFinding)) throw new Error("review_result_malformed")
  for (const key of ["implementation_dispatch_id", "reviewer_dispatch_id", "repository",
    "pull_request_number", "head_sha", "base_sha", "profile", "policy_version"] as const) {
    if (receipt[key] !== subject[key]) throw new Error(`review_subject_mismatch:${key}`)
  }
  if (receipt.result === "accepted" && receipt.findings.some((finding) =>
    finding.severity === "blocking")) throw new Error("review_acceptance_has_blockers")
  return receipt
}

export function reduceMergeEligibility(evidence: MergeGateEvidence): MergeGateDecision {
  if (evidence.lifecycle !== "active") return denied(`lifecycle_${evidence.lifecycle}`)
  const pr = evidence.pull_request
  if (!pr.exists || !pr.open) return denied("pull_request_not_open")
  if (pr.repository !== evidence.repository || pr.base_branch !== evidence.base_branch) {
    return denied("pull_request_mapping_mismatch")
  }
  if (evidence.owned_validation.state !== "succeeded" ||
    evidence.owned_validation.head_sha !== pr.head_sha) return denied("focused_validation_required")
  if (evidence.independent_review_required) {
    const review = evidence.review
    if (!review) return denied("review_not_accepted")
    if (review.state !== "accepted" || review.repository !== pr.repository ||
      review.pull_request_number !== pr.pull_request_number || review.head_sha !== pr.head_sha ||
      review.base_sha !== pr.base_sha || review.policy_version !== evidence.current_policy_version ||
      review.profile !== evidence.expected_profile ||
      review.reviewer_identity !== "independent_reviewer" ||
      review.findings.some((finding) => finding.severity === "blocking")) {
      return denied("review_subject_stale_or_invalid")
    }
  }
  if (!evidence.independent_review_required) {
    if (evidence.authoritative_approvals < 0) return denied("normal_review_approval_unknown")
    if (evidence.authoritative_approvals < 1) return denied("normal_review_approval_required")
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

export function requiresFreshReviewer(input: {
  previousBaseSha: string
  nextBaseSha: string
  previousPolicyVersion: string
  nextPolicyVersion: string
  previousProfile: ReviewProfile
  nextProfile: ReviewProfile
  priorReviewerAvailable: boolean
  completeDiff: boolean
  changedPaths: string[]
  findingPaths: string[]
  previousRiskDimensions: ReviewRiskDimension[]
  correctionRiskDimensions: ReviewRiskDimension[]
}): boolean {
  if (!input.priorReviewerAvailable || !input.completeDiff ||
    input.previousBaseSha !== input.nextBaseSha ||
    input.previousPolicyVersion !== input.nextPolicyVersion ||
    input.previousProfile !== input.nextProfile ||
    input.correctionRiskDimensions.includes("ambiguous") ||
    input.correctionRiskDimensions.some((dimension) =>
      !input.previousRiskDimensions.includes(dimension))) return true
  const findingPaths = new Set(input.findingPaths)
  return input.changedPaths.length === 0 ||
    input.changedPaths.some((path) => !validRepositoryPath(path) || !findingPaths.has(path))
}

export function buildBoundedReviewerPacket(input: {
  subject: ReviewSubject
  issue: { identifier: string; title: string; required_outcome: string }
  applicable_rule_paths: string[]
  changed_paths: string[]
  diff_artifact_ref: string
  ci: Array<{ name: string; conclusion: string; head_sha: string }>
  unresolved_findings?: Array<Pick<ReviewFinding, "id" | "path" | "line" | "required_outcome">>
  correction?: { previous_head_sha: string; complete_diff_artifact_ref: string }
}): Record<string, unknown> {
  if (input.changed_paths.length === 0 || input.changed_paths.length > 500 ||
    input.changed_paths.some((path) => !validRepositoryPath(path)) ||
    !input.diff_artifact_ref || !input.issue.title || !input.issue.required_outcome ||
    input.issue.required_outcome.length > 8_000) throw new Error("review_packet_invalid")
  const packet = { schema_version: 1, subject: input.subject, issue: input.issue,
    applicable_rule_paths: [...input.applicable_rule_paths].sort(),
    changed_paths: [...input.changed_paths].sort(), diff_artifact_ref: input.diff_artifact_ref,
    ci: input.ci.filter((check) => check.head_sha === input.subject.head_sha),
    unresolved_findings: input.unresolved_findings ?? [],
    ...(input.correction ? { correction: input.correction } : {}) }
  if (JSON.stringify(packet).length > 6_500) throw new Error("review_packet_prompt_too_large")
  return packet
}

export function validReviewFinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const finding = value as ReviewFinding
  const keys = ["category", "contract", "evidence", "id", "line", "path",
    "required_outcome", "severity"]
  return Object.keys(finding).sort().join(",") === keys.join(",") &&
    typeof finding.id === "string" && new RegExp(REVIEW_FINDING_ID_PATTERN).test(finding.id) &&
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

function addedPatchLines(patch: string | null | undefined): string {
  if (typeof patch !== "string") return ""
  return patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1)).join("\n")
}

function deletedPatchLines(patch: string | null | undefined): string {
  if (typeof patch !== "string") return ""
  return patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => line.slice(1)).join("\n")
}

function hasPatchEvidence(patch: string | null | undefined): patch is string {
  return typeof patch === "string" && patch.split("\n").some((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---")))
}

function provablySafeCiCommentChange(patch: string | null | undefined): boolean {
  if (typeof patch !== "string") return false
  const changedLines = patch.split("\n").filter((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---")))
  return changedLines.length > 0 && changedLines.every((line) => {
    const content = line.slice(1).trim()
    return content.length === 0 || content.startsWith("#")
  })
}

function denied(reason: string): MergeGateDecision { return { eligible: false, reason } }
