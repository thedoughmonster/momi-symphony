const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseHostReviewStatus(value: unknown): { work_id: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (Object.keys(body).sort().join(",") !== "work_id" ||
    !uuid.test(String(body.work_id ?? ""))) return null
  return { work_id: body.work_id as string }
}
