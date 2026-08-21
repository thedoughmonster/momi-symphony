import { validReviewFinding } from "../../agent-control/src/independent_review.ts"
import type { HostReviewFinding, HostReviewResult, TurnShape } from "./types.ts"

export function extractReviewResult(turn: TurnShape): HostReviewResult | null {
  if (turn.status !== "completed") return null
  const message = [...turn.items].reverse().find((item) =>
    item.type === "agentMessage" && typeof item.text === "string")
  if (!message) return null
  let value: Record<string, unknown>
  try { value = JSON.parse(message.text as string) as Record<string, unknown> } catch { return null }
  const keys = ["findings", "result"]
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    !["accepted", "changes_requested", "inconclusive", "escalate"].includes(String(value.result)) ||
    !Array.isArray(value.findings) || value.findings.length > 100 ||
    !value.findings.every(validReviewFinding) ||
    (value.result === "accepted" && value.findings.some((finding) =>
      (finding as HostReviewFinding).severity === "blocking"))) return null
  return { result: value.result as HostReviewResult["result"],
    findings: value.findings as HostReviewFinding[] }
}
