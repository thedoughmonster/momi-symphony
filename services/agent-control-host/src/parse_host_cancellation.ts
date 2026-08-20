import type { HostCancellation } from "./types.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseHostCancellation(value: unknown): HostCancellation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const common = ["base_branch", "capability_token", "repository", "schema_version",
    "work_id"]
  const expected = [...common, body.schema_version === 1
    ? "target_work_id" : "target_work_ids"].sort().join(",")
  const legacyTarget = body.schema_version === 1 &&
    typeof body.target_work_id === "string" && uuid.test(body.target_work_id)
  const targets = body.schema_version === 2 && Array.isArray(body.target_work_ids)
    ? body.target_work_ids : legacyTarget ? [body.target_work_id] : []
  if (![1, 2].includes(Number(body.schema_version)) ||
    Object.keys(body).sort().join(",") !== expected ||
    !uuid.test(String(body.work_id ?? "")) ||
    !uuid.test(String(body.capability_token ?? "")) ||
    targets.length < 1 || targets.length > 128 ||
    !targets.every((id) => typeof id === "string" && uuid.test(id)) ||
    new Set(targets).size !== targets.length ||
    targets.join("\n") !== [...targets].sort().join("\n") ||
    typeof body.repository !== "string" || typeof body.base_branch !== "string" ||
    !body.repository || !body.base_branch) return null
  return { schema_version: 2, work_id: body.work_id as string,
    capability_token: body.capability_token as string,
    target_work_ids: targets as string[], repository: body.repository,
    base_branch: body.base_branch }
}
