import type { HostRecovery } from "./types.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseHostRecovery(value: unknown): HostRecovery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const expected = ["capability_token", "schema_version", "target_work_id", "work_id"]
    .sort().join(",")
  if (body.schema_version !== 1 || Object.keys(body).sort().join(",") !== expected ||
    !uuid.test(String(body.work_id ?? "")) ||
    !uuid.test(String(body.capability_token ?? "")) ||
    !uuid.test(String(body.target_work_id ?? ""))) return null
  return body as HostRecovery
}
