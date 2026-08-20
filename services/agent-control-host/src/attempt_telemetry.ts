import { Buffer } from "node:buffer"

import type { AttemptTelemetry, HostRecord, TurnShape } from "./types.ts"

export function buildAttemptTelemetry(record: HostRecord, turn: TurnShape,
  disposition: string, endedAt = Date.now()): AttemptTelemetry {
  const usage = turn.usage ?? {}
  const input = integer(usage.input_tokens ?? usage.inputTokens)
  const cached = integer(usage.cached_input_tokens ?? usage.cachedInputTokens)
  const output = integer(usage.output_tokens ?? usage.outputTokens)
  const modelVisibleBytes = turn.items
    .filter((item) => item.type !== "agentMessage")
    .reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0)
  return {
    policy_version: record.policyVersion ?? "legacy",
    stable_prefix_fingerprint: record.stablePrefixFingerprint ?? "legacy",
    context_fingerprint: record.contextFingerprint ?? record.fingerprint,
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    model_visible_tool_bytes: modelVisibleBytes,
    model_turns: integer(usage.model_turns ?? usage.modelTurns) ?? 1,
    no_progress_cycles: integer(usage.no_progress_cycles ?? usage.noProgressCycles) ?? 0,
    subagents: integer(usage.subagents) ?? countSubagents(turn.items),
    max_subagent_depth: integer(usage.max_subagent_depth ?? usage.maxSubagentDepth) ?? 0,
    retries: integer(usage.retries) ?? 0,
    repeated_failure_fingerprints: integer(usage.repeated_failure_fingerprints) ?? 0,
    elapsed_ms: Math.max(0, endedAt - Date.parse(record.startedAt ?? record.updatedAt)),
    disposition,
  }
}

export function budgetDisposition(record: HostRecord,
  telemetry: AttemptTelemetry): string | null {
  const budget = record.budget
  if (!budget) return null
  if (telemetry.model_turns > budget.model_turns) return "budget_model_turns_exhausted"
  if (telemetry.no_progress_cycles > budget.no_progress_cycles) {
    return "budget_no_progress_exhausted"
  }
  if (telemetry.subagents > budget.subagents) return "budget_subagents_exhausted"
  if (telemetry.max_subagent_depth > budget.subagent_depth) {
    return "budget_subagent_depth_exhausted"
  }
  if (telemetry.model_visible_tool_bytes > budget.model_visible_tool_bytes) {
    return "budget_tool_output_exhausted"
  }
  if (telemetry.elapsed_ms > budget.elapsed_ms) return "budget_elapsed_exhausted"
  return null
}

export function buildSyntheticTelemetry(record: HostRecord,
  disposition: "completed" | "failed" | "interrupted",
  endedAt = Date.now()): AttemptTelemetry {
  return { policy_version: record.policyVersion ?? "legacy",
    stable_prefix_fingerprint: record.stablePrefixFingerprint ?? "legacy",
    context_fingerprint: record.contextFingerprint ?? record.fingerprint,
    input_tokens: null, cached_input_tokens: null, output_tokens: null,
    model_visible_tool_bytes: 0, model_turns: 0, no_progress_cycles: 0,
    subagents: 0, max_subagent_depth: 0, retries: 0,
    repeated_failure_fingerprints: 0,
    elapsed_ms: Math.max(0, endedAt - Date.parse(record.startedAt ?? record.updatedAt)),
    disposition }
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function countSubagents(items: Array<Record<string, unknown>>): number {
  return items.filter((item) => item.type === "collabAgentToolCall" ||
    item.type === "subagentCall").length
}
