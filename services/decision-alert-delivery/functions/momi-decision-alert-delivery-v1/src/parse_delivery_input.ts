import type { DeliveryInput } from "./types.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseDeliveryInput(value: unknown): DeliveryInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(",") !== "capability_token,work_id") return null
  if (typeof input.work_id !== "string" || !uuid.test(input.work_id) ||
    typeof input.capability_token !== "string" || !uuid.test(input.capability_token)) return null
  return { work_id: input.work_id, capability_token: input.capability_token }
}
