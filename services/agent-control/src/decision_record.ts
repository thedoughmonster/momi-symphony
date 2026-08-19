export const DECISION_RECORD_MARKER = "momi-decision:v1" as const
export const DECISION_BLOCKING_LABEL = "blocked-external-decision" as const

export const MATERIAL_DECISION_CATEGORIES = [
  "material_architecture_ownership",
  "public_contract",
  "security_privacy",
  "meaningful_cost_external_exposure",
  "destructive_migration",
  "production_infrastructure_authority",
  "ambiguous_product_behavior",
  "repository_law_conflict",
] as const

export const EXCLUDED_DECISION_CATEGORIES = [
  "native_dependency",
  "tests_validation",
  "retryable_infrastructure",
  "stale_branch",
  "missing_generated_file",
  "agent_correctable_defect",
  "active_duplicate",
] as const

export type MaterialDecisionCategory = typeof MATERIAL_DECISION_CATEGORIES[number]
export type ExcludedDecisionCategory = typeof EXCLUDED_DECISION_CATEGORIES[number]
export type DecisionCategory = MaterialDecisionCategory | ExcludedDecisionCategory
export type DecisionStatus = "unresolved" | "resolved"

export type LinearDecisionRecord = {
  decision_key: string
  category: DecisionCategory
  status: DecisionStatus
  question: string
  policy_gap: string
  recommendation: string
  alternatives: string[]
  consequences: string[]
  affected_issue_identifiers: string[]
  resolution_summary: string | null
}

export type LinearDecisionComment = LinearDecisionRecord & {
  comment_id: string
}

export type DecisionClassification =
  | { alertable: true; category: MaterialDecisionCategory }
  | { alertable: false; reason: "explicit_technical_exclusion" | "category_unknown" }

export type DecisionParseResult =
  | { ok: true; record: LinearDecisionRecord }
  | { ok: false; reason: string }

const identityPattern = /^[a-z0-9][a-z0-9._:-]{2,79}$/
const issueIdentifierPattern = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$/
const controlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
const mentionPattern = /<!(?:channel|here|everyone|subteam)|<@[A-Z0-9]+>/i
const secretPattern = /(?:xox[a-z]-|sk-[a-z0-9_-]{8,}|bearer\s+[a-z0-9._~-]{8,}|(?:api[_ -]?key|token|password|secret)\s*[:=]\s*\S{6,})/i

export function classifyDecisionCategory(value: unknown): DecisionClassification {
  if (typeof value !== "string") return { alertable: false, reason: "category_unknown" }
  if ((MATERIAL_DECISION_CATEGORIES as readonly string[]).includes(value)) {
    return { alertable: true, category: value as MaterialDecisionCategory }
  }
  if ((EXCLUDED_DECISION_CATEGORIES as readonly string[]).includes(value)) {
    return { alertable: false, reason: "explicit_technical_exclusion" }
  }
  return { alertable: false, reason: "category_unknown" }
}

export function parseLinearDecisionComment(body: string): DecisionParseResult {
  const trimmed = body.trim()
  const prefix = `${DECISION_RECORD_MARKER}\n\`\`\`json\n`
  const suffix = "\n```"
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(suffix)) {
    return { ok: false, reason: "decision_record_envelope_invalid" }
  }
  const encoded = trimmed.slice(prefix.length, -suffix.length)
  if (encoded.length < 2 || encoded.length > 5_000) {
    return { ok: false, reason: "decision_record_size_invalid" }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(encoded)
  } catch {
    return { ok: false, reason: "decision_record_json_invalid" }
  }
  const value = asRecord(decoded)
  if (!value) return { ok: false, reason: "decision_record_shape_invalid" }
  const expected = [
    "affected_issue_identifiers", "alternatives", "category", "consequences",
    "decision_key", "policy_gap", "question", "recommendation",
    "resolution_summary", "status",
  ]
  if (Object.keys(value).sort().join("\n") !== expected.sort().join("\n")) {
    return { ok: false, reason: "decision_record_fields_invalid" }
  }
  if (!text(value.decision_key, 3, 80) || !identityPattern.test(value.decision_key as string)) {
    return { ok: false, reason: "decision_key_invalid" }
  }
  const classification = classifyDecisionCategory(value.category)
  if (!classification.alertable) return { ok: false, reason: classification.reason }
  if (value.status !== "unresolved" && value.status !== "resolved") {
    return { ok: false, reason: "decision_status_invalid" }
  }
  for (const [key, min, max] of [
    ["question", 10, 500], ["policy_gap", 10, 500],
    ["recommendation", 3, 500],
  ] as const) {
    if (!text(value[key], min, max) || unsafeText(value[key] as string)) {
      return { ok: false, reason: `${key}_invalid` }
    }
  }
  const alternatives = textArray(value.alternatives, 1, 5, 1, 300)
  if (!alternatives) return { ok: false, reason: "alternatives_invalid" }
  const consequences = textArray(value.consequences, 1, 5, 1, 300)
  if (!consequences) return { ok: false, reason: "consequences_invalid" }
  const affected = identifierArray(value.affected_issue_identifiers)
  if (!affected) return { ok: false, reason: "affected_issue_identifiers_invalid" }
  const resolution = value.resolution_summary
  if (value.status === "unresolved" && resolution !== null) {
    return { ok: false, reason: "unresolved_resolution_present" }
  }
  if (value.status === "resolved" &&
    (!text(resolution, 3, 500) || unsafeText(resolution as string))) {
    return { ok: false, reason: "resolution_summary_invalid" }
  }
  return { ok: true, record: {
    decision_key: value.decision_key as string,
    category: classification.category,
    status: value.status,
    question: value.question as string,
    policy_gap: value.policy_gap as string,
    recommendation: value.recommendation as string,
    alternatives,
    consequences,
    affected_issue_identifiers: affected,
    resolution_summary: resolution as string | null,
  } }
}

export function selectLinearDecision(
  comments: readonly { id: string; body: string }[],
): { decision: LinearDecisionComment | null; reason: string } {
  const candidates = comments.filter((comment) =>
    comment.body.trim().startsWith(`${DECISION_RECORD_MARKER}\n`)
  )
  if (candidates.length === 0) return { decision: null, reason: "decision_record_missing" }
  if (candidates.length !== 1) return { decision: null, reason: "decision_record_ambiguous" }
  const parsed = parseLinearDecisionComment(candidates[0].body)
  if (!parsed.ok) return { decision: null, reason: parsed.reason }
  return { decision: { ...parsed.record, comment_id: candidates[0].id }, reason: "decision_record_valid" }
}

export function decisionIdentity(issueId: string, decision: LinearDecisionComment): string {
  return `linear:${issueId}:${decision.comment_id}:${decision.decision_key}`
}

export function decisionRecordMatchesLabel(
  decision: LinearDecisionComment,
  labels: readonly string[],
): { eligible: boolean; reason: string } {
  const blocked = labels.some((label) => label.trim().toLowerCase() === DECISION_BLOCKING_LABEL)
  if (decision.status === "unresolved" && blocked) return { eligible: true, reason: "unresolved" }
  if (decision.status === "resolved" && !blocked) return { eligible: true, reason: "resolved" }
  return { eligible: false, reason: decision.status === "unresolved"
    ? "decision_label_missing" : "resolution_label_still_present" }
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value === value.trim() &&
    value.length >= min && value.length <= max && !value.includes("\n")
}

function unsafeText(value: string): boolean {
  return controlPattern.test(value) || mentionPattern.test(value) || secretPattern.test(value)
}

function textArray(
  value: unknown, minItems: number, maxItems: number, minLength: number, maxLength: number,
): string[] | null {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) return null
  const result: string[] = []
  for (const item of value) {
    if (!text(item, minLength, maxLength) || unsafeText(item)) return null
    if (result.includes(item)) return null
    result.push(item)
  }
  return result
}

function identifierArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null
  const values = value.map((item) => typeof item === "string" ? item : "")
  if (values.some((item) => !issueIdentifierPattern.test(item))) return null
  if (new Set(values).size !== values.length) return null
  return [...values].sort()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
