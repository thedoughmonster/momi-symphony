import type { TurnShape } from "./types.ts"

export function parseTerminalNotification(
  notification: Record<string, unknown>,
): { threadId: string; turn: TurnShape } | null {
  if (notification.method !== "turn/completed" || !notification.params ||
    typeof notification.params !== "object" || Array.isArray(notification.params)) return null
  const params = notification.params as Record<string, unknown>
  const turn = params.turn
  if (typeof params.threadId !== "string" || !turn || typeof turn !== "object" ||
    Array.isArray(turn)) return null
  const value = turn as Record<string, unknown>
  if (typeof value.id !== "string" || !Array.isArray(value.items) ||
    !["completed", "interrupted", "failed"].includes(String(value.status))) return null
  return { threadId: params.threadId, turn: value as TurnShape }
}
