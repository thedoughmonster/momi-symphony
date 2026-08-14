import type { HostDispatch } from "./types.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseHostDispatch(value: unknown): HostDispatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const requiredStrings = ["work_id", "capability_token", "issue_id", "issue_identifier",
    "issue_url", "project_id", "project_name", "repository", "base_branch", "instruction"]
  if (body.schema_version !== 1 || requiredStrings.some((key) => typeof body[key] !== "string") ||
    !uuid.test(String(body.work_id)) || !uuid.test(String(body.capability_token)) ||
    !uuid.test(String(body.issue_id)) || !uuid.test(String(body.project_id)) ||
    !Array.isArray(body.active_states) ||
    !body.active_states.every((state) => typeof state === "string") ||
    body.active_states.length < 1 || body.active_states.length > 12 ||
    String(body.instruction).length < 40 || String(body.instruction).length > 4000 ||
    !String(body.issue_url).startsWith("https://linear.app/")) return null
  const expected = ["active_states", "base_branch", "capability_token", "instruction",
    "issue_id", "issue_identifier", "issue_url", "project_id", "project_name", "repository",
    "schema_version", "work_id"].sort().join(",")
  if (Object.keys(body).sort().join(",") !== expected) return null
  return body as HostDispatch
}
