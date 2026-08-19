import type { DispatchInput, SchedulerPumpInput, TerminalInput } from "./types.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseDispatchInput(
  value: unknown,
): DispatchInput | SchedulerPumpInput | TerminalInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (body.event === "scheduler_pump") {
    const active = body.active_work_ids
    const keys = Object.keys(body).sort().join(",")
    if (!uuid.test(String(body.scheduler_id ?? "")) || !Array.isArray(active) ||
      !/^[0-9a-f]{40}$/.test(String(body.release_sha ?? "")) ||
      active.length > 128 || active.some((workId) => !uuid.test(String(workId))) ||
      new Set(active).size !== active.length ||
      keys !== "active_work_ids,event,release_sha,scheduler_id") return null
    return { event: "scheduler_pump", scheduler_id: body.scheduler_id as string,
      release_sha: body.release_sha as string,
      active_work_ids: active as string[] }
  }
  if (!uuid.test(String(body.work_id ?? "")) ||
    !uuid.test(String(body.capability_token ?? ""))) return null
  if (body.event === undefined) {
    const keys = Object.keys(body).sort().join(",")
    return keys === "capability_token,work_id"
      ? { work_id: body.work_id as string, capability_token: body.capability_token as string }
      : null
  }
  if (body.event !== "terminal" || typeof body.thread_id !== "string" ||
    typeof body.turn_id !== "string" || typeof body.archived_at !== "string" ||
    !["ready", "unready", "failed"].includes(String(body.readiness_result)) ||
    !["completed", "failed", "interrupted"].includes(String(body.terminal_disposition)) ||
    Number.isNaN(Date.parse(body.archived_at)) ||
    (body.summary !== undefined && typeof body.summary !== "string") ||
    String(body.summary ?? "").length > 1000) return null
  const expected = ["archived_at", "capability_token", "event", "readiness_result",
    "terminal_disposition", "thread_id", "turn_id", "work_id",
    ...(body.summary === undefined ? [] : ["summary"])].sort().join(",")
  if (Object.keys(body).sort().join(",") !== expected) return null
  return { event: "terminal", work_id: body.work_id as string,
    capability_token: body.capability_token as string,
    thread_id: body.thread_id, turn_id: body.turn_id,
    readiness_result: body.readiness_result as TerminalInput["readiness_result"],
    terminal_disposition: body.terminal_disposition as TerminalInput["terminal_disposition"],
    archived_at: body.archived_at, summary: String(body.summary ?? "") }
}
