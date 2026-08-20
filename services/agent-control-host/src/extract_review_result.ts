import { createHash } from "node:crypto"

import type { HostReviewFinding, HostReviewResult, TurnShape } from "./types.ts"

export function extractReviewResult(turn: TurnShape): HostReviewResult | null {
  if (turn.status !== "completed") return null
  const message = [...turn.items].reverse().find((item) =>
    item.type === "agentMessage" && typeof item.text === "string")
  if (!message) return null
  let value: Record<string, unknown>
  try { value = JSON.parse(message.text as string) as Record<string, unknown> } catch { return null }
  const keys = ["artifact_ref", "findings", "result"]
  if (Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    !["accepted", "changes_requested", "inconclusive", "escalate"].includes(String(value.result)) ||
    !Array.isArray(value.findings) || value.findings.length > 100 ||
    !value.findings.every(validFinding) || typeof value.artifact_ref !== "string" ||
    value.artifact_ref.length < 1 || value.artifact_ref.length > 500 ||
    (value.result === "accepted" && value.findings.some((finding) =>
      (finding as HostReviewFinding).severity === "blocking"))) return null
  const canonical = JSON.stringify({ result: value.result, findings: value.findings,
    artifact_ref: value.artifact_ref })
  return { result: value.result as HostReviewResult["result"],
    findings: value.findings as HostReviewFinding[], artifact_ref: value.artifact_ref,
    result_fingerprint: `sha256:${createHash("sha256").update(canonical).digest("hex")}` }
}

function validFinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const finding = value as Record<string, unknown>
  const keys = ["category", "contract", "evidence", "id", "line", "path",
    "required_outcome", "severity"]
  return Object.keys(finding).sort().join(",") === keys.sort().join(",") &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/.test(String(finding.id)) &&
    ["blocking", "nonblocking"].includes(String(finding.severity)) &&
    typeof finding.category === "string" && finding.category.length <= 120 &&
    typeof finding.path === "string" && finding.path.length > 0 && finding.path.length <= 500 &&
    !finding.path.startsWith("/") && !finding.path.split("/").includes("..") &&
    (finding.line === null || (Number.isSafeInteger(finding.line) && Number(finding.line) > 0)) &&
    [finding.contract, finding.required_outcome, finding.evidence].every((text) =>
      typeof text === "string" && text.length > 0 && text.length <= 2_000)
}
