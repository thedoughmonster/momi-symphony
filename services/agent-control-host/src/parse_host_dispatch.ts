import type { HostDispatch } from "./types.ts"
import { reviewExecutionBudget, reviewExecutionProfile } from
  "../../agent-control/src/independent_review.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseHostDispatch(value: unknown): HostDispatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const commonStrings = ["work_id", "capability_token", "issue_id", "issue_identifier",
    "issue_url", "project_id", "project_name", "repository", "base_branch"]
  if (![1, 2, 3, 4].includes(body.schema_version as number) ||
    commonStrings.some((key) => typeof body[key] !== "string") ||
    !uuid.test(String(body.work_id)) || !uuid.test(String(body.capability_token)) ||
    !uuid.test(String(body.issue_id)) || !uuid.test(String(body.project_id)) ||
    !Array.isArray(body.active_states) ||
    !body.active_states.every((state) => typeof state === "string") ||
    body.active_states.length < 1 || body.active_states.length > 12 ||
    !String(body.issue_url).startsWith("https://linear.app/")) return null
  const legacy = ["active_states", "base_branch", "capability_token", "instruction",
    "issue_id", "issue_identifier", "issue_url", "project_id", "project_name", "repository",
    "schema_version", "work_id"].sort().join(",")
  const interactive = [...legacy.split(","), "interaction_mode", "thread_name"]
    .sort().join(",")
  const compact = ["active_states", "base_branch", "budget", "capability_token",
    "context_fingerprint", "interaction_mode", "issue_id", "issue_identifier", "issue_url",
    "policy_version", "project_id", "project_name", "repository", "schema_version",
    "stable_instruction", "stable_prefix_fingerprint", "thread_name", "volatile_context",
    "work_id"].sort().join(",")
  const reviewer = ["active_states", "base_branch", "budget", "capability_token",
    "context_fingerprint", "interaction_mode", "issue_id", "issue_identifier", "issue_url",
    "policy_version", "project_id", "project_name", "repository", "review_subject",
    "runtime_role", "schema_version", "stable_instruction", "stable_prefix_fingerprint",
    "thread_name", "volatile_context", "work_id", "review_workspace_id"].sort().join(",")
  const reviewerReverification = [...reviewer.split(","), "review_thread_id"].sort().join(",")
  const actual = Object.keys(body).sort().join(",")
  if (body.schema_version === 1 && (actual !== legacy || !validInstruction(body.instruction))) return null
  if (body.schema_version === 2 && (actual !== interactive ||
    !["one_shot", "interactive"].includes(String(body.interaction_mode)) ||
    typeof body.thread_name !== "string" || body.thread_name.length < 1 ||
    body.thread_name.length > 120 || !validInstruction(body.instruction))) return null
  if (body.schema_version === 3 && (actual !== compact ||
    !["one_shot", "interactive"].includes(String(body.interaction_mode)) ||
    typeof body.thread_name !== "string" || body.thread_name.length < 1 ||
    body.thread_name.length > 120 || !validInstruction(body.stable_instruction) ||
    !validInstruction(body.volatile_context) || !validFingerprint(body.context_fingerprint) ||
    !validFingerprint(body.stable_prefix_fingerprint) ||
    typeof body.policy_version !== "string" || !validBudget(body.budget))) return null
  if (body.schema_version === 4 && (![reviewer, reviewerReverification].includes(actual) ||
    body.interaction_mode !== "one_shot" || body.runtime_role !== "independent_reviewer" ||
    typeof body.thread_name !== "string" || body.thread_name.length < 1 ||
    body.thread_name.length > 120 || !validInstruction(body.stable_instruction) ||
    !validInstruction(body.volatile_context) || !validFingerprint(body.context_fingerprint) ||
    !validFingerprint(body.stable_prefix_fingerprint) ||
    typeof body.policy_version !== "string" || !validBudget(body.budget) ||
    !uuid.test(String(body.review_workspace_id ?? "")) ||
    (body.review_thread_id !== undefined &&
      (typeof body.review_thread_id !== "string" || body.review_thread_id.length < 1 ||
        body.review_thread_id.length > 200)) ||
    !validReviewSubject(body.review_subject, body.policy_version) ||
    !validReviewBudget(body.budget, body.review_subject))) return null
  return { ...body,
    interaction_mode: body.schema_version === 1 ? "one_shot" : body.interaction_mode,
    thread_name: body.schema_version !== 1
      ? body.thread_name : `${body.issue_identifier} · agent run` } as HostDispatch
}

function validReviewSubject(value: unknown, policyVersion: unknown): boolean {
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
    typeof body.policy_version === "string" && body.policy_version === policyVersion
}

function validInstruction(value: unknown): boolean {
  return typeof value === "string" && value.length >= 40 && value.length <= 8_000
}

function validFingerprint(value: unknown): boolean {
  return typeof value === "string" && /^fnv1a64:[0-9a-f]{16}$/.test(value)
}

function validBudget(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  const keys = ["elapsed_ms", "model_turns", "model_visible_tool_bytes",
    "no_progress_cycles", "subagent_depth", "subagents"]
  const maximum: Record<string, number> = { elapsed_ms: 7_200_000, model_turns: 64,
    model_visible_tool_bytes: 96_000, no_progress_cycles: 3,
    subagent_depth: 1, subagents: 3 }
  return Object.keys(body).sort().join(",") === keys.sort().join(",") &&
    keys.every((key) => Number.isSafeInteger(body[key]) && Number(body[key]) >= 0 &&
      Number(body[key]) <= maximum[key])
}

function validReviewBudget(value: unknown, subject: unknown): boolean {
  if (!subject || typeof subject !== "object" || Array.isArray(subject) ||
    !value || typeof value !== "object" || Array.isArray(value)) return false
  const profile = String((subject as Record<string, unknown>).profile) as
    "low" | "standard" | "high"
  if (!["low", "standard", "high"].includes(profile)) return false
  const actual = value as Record<string, unknown>
  const expected = reviewExecutionBudget(profile)
  return Object.keys(actual).sort().join(",") === Object.keys(expected).sort().join(",") &&
    Object.entries(expected).every(([key, expectedValue]) => actual[key] === expectedValue)
}
