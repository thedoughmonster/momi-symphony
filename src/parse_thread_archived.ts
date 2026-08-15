export function parseThreadArchived(notification: Record<string, unknown>): string | null {
  if (notification.method !== "thread/archived") return null
  const params = notification.params as Record<string, unknown> | undefined
  return typeof params?.threadId === "string" ? params.threadId : null
}
