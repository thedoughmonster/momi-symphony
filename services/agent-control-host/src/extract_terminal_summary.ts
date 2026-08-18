import type { TerminalSummary, TurnShape } from "./types.ts"

export function extractTerminalSummary(turn: TurnShape): TerminalSummary {
  const message = [...turn.items].reverse().find((item) =>
    item.type === "agentMessage" && typeof item.text === "string")
  if (turn.status === "completed" && message) {
    try {
      const value = JSON.parse(message.text as string) as Record<string, unknown>
      if (["ready", "unready", "failed"].includes(String(value.readiness_result)) &&
        ["completed", "failed", "interrupted"].includes(String(value.disposition)) &&
        typeof value.summary === "string" && value.summary.length <= 1000) {
        return { readiness_result: value.readiness_result as TerminalSummary["readiness_result"],
          terminal_disposition: value.disposition as TerminalSummary["terminal_disposition"],
          summary: value.summary }
      }
    } catch {
      // Structured output failure is represented as a failed terminal receipt.
    }
  }
  return { readiness_result: "failed",
    terminal_disposition: turn.status === "interrupted" ? "interrupted" : "failed",
    summary: "Codex turn ended without a valid structured terminal summary." }
}
