import type { JSONValue } from "postgres"

import type { NormalizedLinearEvent } from "./types.ts"

export function normalizeLinearEvent(rawBody: Uint8Array): NormalizedLinearEvent | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody))
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  const dataValue = payload.data
  const data = dataValue && typeof dataValue === "object" && !Array.isArray(dataValue)
    ? dataValue as Record<string, unknown> : {}
  const updatedValue = payload.updatedFrom
  const updated = updatedValue && typeof updatedValue === "object" && !Array.isArray(updatedValue)
    ? updatedValue as Record<string, unknown> : {}
  const projectValue = data.project
  const project = projectValue && typeof projectValue === "object" && !Array.isArray(projectValue)
    ? projectValue as Record<string, unknown> : {}
  const labelsChanged = Object.prototype.hasOwnProperty.call(updated, "labels")
  const names = (candidate: unknown): string[] => {
    if (!Array.isArray(candidate)) return []
    return [...new Set(candidate.flatMap((label) => {
      if (typeof label === "string") return [label]
      if (!label || typeof label !== "object" || Array.isArray(label)) return []
      const name = (label as Record<string, unknown>).name
      return typeof name === "string" ? [name] : []
    }))].sort()
  }
  const before = labelsChanged ? names(updated.labels) : []
  const after = labelsChanged ? names(data.labels) : []
  const executeRunAdded = labelsChanged && !before.includes("execute-run") &&
    after.includes("execute-run")
  const text = (candidate: unknown) => typeof candidate === "string" ? candidate : null
  const number = (candidate: unknown) => typeof candidate === "number" ? candidate : null
  return {
    payload: payload as Record<string, JSONValue>,
    webhookId: text(payload.webhookId),
    webhookTimestamp: number(payload.webhookTimestamp),
    eventType: text(payload.type),
    eventAction: text(payload.action),
    issueId: text(data.id),
    issueIdentifier: text(data.identifier),
    issueUrl: text(payload.url) ?? text(data.url),
    projectId: text(data.projectId) ?? text(project.id),
    projectName: text(data.projectName) ?? text(project.name),
    executeRunAdded,
    changedFields: labelsChanged ? { labels: { before, after } } : {},
  }
}
