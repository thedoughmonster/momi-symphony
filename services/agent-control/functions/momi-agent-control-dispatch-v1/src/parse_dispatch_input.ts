import { reviewExecutionProfile, validReviewFinding } from "../../../src/independent_review.ts"
import type { DispatchInput, LifecycleEvidenceInput, MergePreflightInput, SchedulerPumpInput,
  ReviewRequestInput, ReviewStatusInput, ReviewTerminalInput, TerminalInput } from "./types.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseDispatchInput(
  value: unknown,
): DispatchInput | LifecycleEvidenceInput | MergePreflightInput | ReviewRequestInput | ReviewStatusInput |
  ReviewTerminalInput | SchedulerPumpInput | TerminalInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (body.event === "review_terminal") return parseReviewTerminal(body)
  if (body.event === "scheduler_pump") {
    const active = body.active_work_ids
    const keys = Object.keys(body).sort().join(",")
    if (!uuid.test(String(body.scheduler_id ?? "")) || !Array.isArray(active) ||
      !/^[0-9a-f]{40}$/.test(String(body.release_sha ?? "")) ||
      active.length > 128 || active.some((workId) => !uuid.test(String(workId))) ||
      new Set(active).size !== active.length ||
      keys !== "active_work_ids,event,release_sha,scheduler_id") return null
    return { event: "scheduler_pump", scheduler_id: body.scheduler_id as string,
      release_sha: body.release_sha as string,
      active_work_ids: active as string[] }
  }
  if (!uuid.test(String(body.work_id ?? "")) ||
    !uuid.test(String(body.capability_token ?? ""))) return null
  if (body.event === undefined) {
    const keys = Object.keys(body).sort().join(",")
    return keys === "capability_token,work_id"
      ? { work_id: body.work_id as string, capability_token: body.capability_token as string }
      : null
  }
  if (body.event === "review_request") return parseReviewRequest(body)
  if (body.event === "merge_preflight") return parseMergePreflight(body)
  if (body.event === "review_status") {
    const keys = ["capability_token", "event", "thread_id", "turn_id", "work_id"]
    if (Object.keys(body).sort().join(",") !== keys.sort().join(",") ||
      typeof body.thread_id !== "string" || typeof body.turn_id !== "string") return null
    return body as ReviewStatusInput
  }
  if (body.event === "lifecycle_evidence") return parseLifecycleEvidence(body)
  if (body.event !== "terminal" || typeof body.thread_id !== "string" ||
    typeof body.turn_id !== "string" || typeof body.archived_at !== "string" ||
    !["ready", "unready", "failed"].includes(String(body.readiness_result)) ||
    !["completed", "failed", "interrupted"].includes(String(body.terminal_disposition)) ||
    Number.isNaN(Date.parse(body.archived_at)) ||
    (body.summary !== undefined && typeof body.summary !== "string") ||
    String(body.summary ?? "").length > 1000 || !validTelemetry(body.telemetry)) return null
  const expected = ["archived_at", "capability_token", "event", "readiness_result",
    "terminal_disposition", "thread_id", "turn_id", "work_id",
    "telemetry", ...(body.summary === undefined ? [] : ["summary"])].sort().join(",")
  if (Object.keys(body).sort().join(",") !== expected) return null
  return { event: "terminal", work_id: body.work_id as string,
    capability_token: body.capability_token as string,
    thread_id: body.thread_id, turn_id: body.turn_id,
    readiness_result: body.readiness_result as TerminalInput["readiness_result"],
    terminal_disposition: body.terminal_disposition as TerminalInput["terminal_disposition"],
    archived_at: body.archived_at, summary: String(body.summary ?? ""),
    telemetry: body.telemetry as TerminalInput["telemetry"] }
}

function parseMergePreflight(body: Record<string, unknown>): MergePreflightInput | null {
  const keys = ["base_branch", "capability_token", "event", "pull_request_number",
    "repository", "thread_id", "turn_id", "work_id"]
  if (Object.keys(body).sort().join(",") !== keys.sort().join(",") ||
    typeof body.thread_id !== "string" || typeof body.turn_id !== "string" ||
    typeof body.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repository) ||
    typeof body.base_branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(body.base_branch) ||
    !Number.isSafeInteger(body.pull_request_number) || Number(body.pull_request_number) < 1) return null
  return body as MergePreflightInput
}

function parseReviewRequest(body: Record<string, unknown>): ReviewRequestInput | null {
  const keys = ["base_branch", "branch_name", "capability_token", "event",
    "pull_request_number", "repository", "thread_id", "turn_id", "work_id"]
  if (Object.keys(body).sort().join(",") !== keys.sort().join(",") ||
    typeof body.thread_id !== "string" || typeof body.turn_id !== "string" ||
    typeof body.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repository) ||
    typeof body.base_branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(body.base_branch) ||
    typeof body.branch_name !== "string" || !/^[A-Za-z0-9._/-]+$/.test(body.branch_name) ||
    !Number.isSafeInteger(body.pull_request_number) || Number(body.pull_request_number) < 1) return null
  return body as ReviewRequestInput
}

function parseReviewTerminal(body: Record<string, unknown>): ReviewTerminalInput | null {
  const keys = ["archived_at", "capability_token", "event", "review_result",
    "review_subject", "reviewer_dispatch_id", "runtime_role", "telemetry",
    "terminal_disposition", "thread_id", "turn_id"]
  if (Object.keys(body).sort().join(",") !== keys.sort().join(",") ||
    !uuid.test(String(body.reviewer_dispatch_id)) ||
    !uuid.test(String(body.capability_token)) || body.runtime_role !== "independent_reviewer" ||
    typeof body.thread_id !== "string" || typeof body.turn_id !== "string" ||
    !["completed", "failed", "interrupted"].includes(String(body.terminal_disposition)) ||
    typeof body.archived_at !== "string" || Number.isNaN(Date.parse(body.archived_at)) ||
    !validReviewSubject(body.review_subject) || !validTelemetry(body.telemetry)) return null
  if (body.review_result !== null && !validReviewResult(body.review_result)) return null
  if ((body.terminal_disposition === "completed") !== (body.review_result !== null)) return null
  return body as ReviewTerminalInput
}

function validReviewSubject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  const keys = ["base_sha", "generation", "head_sha", "implementation_dispatch_id",
    "model", "policy_version", "profile", "pull_request_number", "reasoning_effort"]
  const profile = String(body.profile) as "low" | "standard" | "high"
  if (!["low", "standard", "high"].includes(profile)) return false
  const execution = reviewExecutionProfile(profile)
  return Object.keys(body).sort().join(",") === keys.sort().join(",") &&
    uuid.test(String(body.implementation_dispatch_id)) &&
    Number.isSafeInteger(body.pull_request_number) && Number(body.pull_request_number) > 0 &&
    /^[0-9a-f]{40}$/.test(String(body.head_sha)) &&
    /^[0-9a-f]{40}$/.test(String(body.base_sha)) &&
    Number.isSafeInteger(body.generation) && Number(body.generation) > 0 &&
    body.model === execution.model && body.reasoning_effort === execution.reasoning_effort &&
    typeof body.policy_version === "string" && body.policy_version.length > 0 &&
    body.policy_version.length <= 120
}

function validReviewResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  const keys = ["artifact_ref", "findings", "result", "result_fingerprint"]
  return Object.keys(body).sort().join(",") === keys.sort().join(",") &&
    ["accepted", "changes_requested", "inconclusive", "escalate"].includes(String(body.result)) &&
    Array.isArray(body.findings) && body.findings.length <= 100 &&
    body.findings.every(validReviewFinding) &&
    typeof body.artifact_ref === "string" && body.artifact_ref.length > 0 &&
    body.artifact_ref.length <= 500 &&
    /^sha256:[0-9a-f]{64}$/.test(String(body.result_fingerprint))
}

function parseLifecycleEvidence(body: Record<string, unknown>): LifecycleEvidenceInput | null {
  const required = ["base_branch", "branch_name", "capability_token", "event", "phase",
    "previous_revision_sha", "pull_request_number", "repository", "revision_sha", "status",
    "thread_id", "turn_id", "work_id"]
  const optional = ["merge_sha", "workflow_run_id"].filter((key) => body[key] !== undefined)
  if (Object.keys(body).sort().join(",") !== [...required, ...optional].sort().join(",") ||
    !["validating", "releasing"].includes(String(body.phase)) ||
    !["pending", "running", "succeeded", "failed"].includes(String(body.status)) ||
    typeof body.thread_id !== "string" || typeof body.turn_id !== "string" ||
    typeof body.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.repository) ||
    typeof body.base_branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(body.base_branch) ||
    typeof body.branch_name !== "string" || !/^[A-Za-z0-9._/-]+$/.test(body.branch_name) ||
    !Number.isSafeInteger(body.pull_request_number) || Number(body.pull_request_number) < 1 ||
    (body.previous_revision_sha !== null &&
      !/^[0-9a-f]{40}$/.test(String(body.previous_revision_sha))) ||
    !/^[0-9a-f]{40}$/.test(String(body.revision_sha)) ||
    (body.merge_sha !== undefined && !/^[0-9a-f]{40}$/.test(String(body.merge_sha))) ||
    (body.workflow_run_id !== undefined &&
      (typeof body.workflow_run_id !== "string" || body.workflow_run_id.length > 160))) return null
  if (body.phase === "releasing" && body.merge_sha !== body.revision_sha) return null
  return body as LifecycleEvidenceInput
}

function validTelemetry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  const keys = ["cached_input_tokens", "context_fingerprint", "disposition", "elapsed_ms",
    "input_tokens", "max_subagent_depth", "model_turns", "model_visible_tool_bytes",
    "no_progress_cycles", "output_tokens",
    "policy_version", "repeated_failure_fingerprints", "retries", "stable_prefix_fingerprint",
    "subagents"]
  if (Object.keys(body).sort().join(",") !== keys.sort().join(",") ||
    !["completed", "failed", "interrupted"].includes(String(body.disposition))) return false
  for (const key of ["model_turns", "model_visible_tool_bytes", "no_progress_cycles",
    "subagents", "max_subagent_depth", "retries",
    "repeated_failure_fingerprints", "elapsed_ms"]) {
    if (!Number.isSafeInteger(body[key]) || Number(body[key]) < 0) return false
  }
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
    if (body[key] !== null && (!Number.isSafeInteger(body[key]) || Number(body[key]) < 0)) return false
  }
  return ["policy_version", "stable_prefix_fingerprint", "context_fingerprint"]
    .every((key) => typeof body[key] === "string" && String(body[key]).length <= 160)
}
