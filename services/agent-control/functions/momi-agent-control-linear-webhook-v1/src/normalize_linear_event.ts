import type { JSONValue } from "postgres"

import { AGENT_ACTIONS } from "../../../src/actions.ts"
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
  const parentValue = data.parent
  const parent = parentValue && typeof parentValue === "object" && !Array.isArray(parentValue)
    ? parentValue as Record<string, unknown> : {}
  const labelsChanged = Object.prototype.hasOwnProperty.call(updated, "labels") ||
    Object.prototype.hasOwnProperty.call(updated, "labelIds")
  const names = (candidate: unknown): string[] => {
    if (!Array.isArray(candidate)) return []
    return [...new Set(candidate.flatMap((label) => {
      if (typeof label === "string") return [label]
      if (!label || typeof label !== "object" || Array.isArray(label)) return []
      const name = (label as Record<string, unknown>).name
      return typeof name === "string" ? [name] : []
    }))].sort()
  }
  const labelObjects = Array.isArray(data.labels)
    ? data.labels.filter((label) => label && typeof label === "object" && !Array.isArray(label))
      .map((label) => label as Record<string, unknown>) : []
  const beforeIds = Array.isArray(updated.labelIds)
    ? updated.labelIds.filter((id): id is string => typeof id === "string") : []
  const labelNamesById = new Map(labelObjects.flatMap((label) =>
    typeof label.id === "string" && typeof label.name === "string"
      ? [[label.id, label.name] as const] : []))
  const before = Object.prototype.hasOwnProperty.call(updated, "labels")
    ? names(updated.labels)
    : [...new Set(beforeIds.flatMap((id) => labelNamesById.get(id) ?? []))].sort()
  const after = labelsChanged ? names(data.labels) : []
  const usesIds = Object.prototype.hasOwnProperty.call(updated, "labelIds")
  const addedActions = labelsChanged ? AGENT_ACTIONS.filter((action) => {
    const labelId = labelObjects.find((label) => label.name === action)?.id
    return after.includes(action) && (usesIds
      ? typeof labelId === "string" && !beforeIds.includes(labelId)
      : !before.includes(action))
  }) : []
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
    parentIssueId: text(data.parentId) ?? text(parent.id),
    action: addedActions.length === 1 ? addedActions[0] : null,
    changedFields: labelsChanged ? { labels: { before, after } } : {},
  }
}
