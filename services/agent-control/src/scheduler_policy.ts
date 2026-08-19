export type SchedulableIssue = {
  id: string
  identifier: string
  title: string
  state: string
  priority: number | null
  created_at: string | null
  url: string | null
  labels: readonly string[]
  dispatchable: boolean
}

export type SchedulerEligibilityReason =
  | "eligible"
  | "adapter_unroutable"
  | "inactive_state"
  | "required_label_missing"
  | "invalid_issue_url"

export type SchedulerEligibility = {
  eligible: boolean
  reason: SchedulerEligibilityReason
}

export type SchedulerEligibilityPolicy = {
  activeStates: readonly string[]
  requiredLabels: readonly string[]
}

const normalized = (value: string): string => value.trim().toLocaleLowerCase("en-US")

export function schedulerEligibility(
  issue: SchedulableIssue,
  policy: SchedulerEligibilityPolicy,
): SchedulerEligibility {
  if (!issue.dispatchable) return { eligible: false, reason: "adapter_unroutable" }
  if (!/^https:\/\/linear\.app\//.test(issue.url ?? "")) {
    return { eligible: false, reason: "invalid_issue_url" }
  }
  const active = new Set(policy.activeStates.map(normalized).filter(Boolean))
  if (!active.has(normalized(issue.state))) {
    return { eligible: false, reason: "inactive_state" }
  }
  const labels = new Set(issue.labels.map(normalized).filter(Boolean))
  if (policy.requiredLabels.some((label) => !labels.has(normalized(label)))) {
    return { eligible: false, reason: "required_label_missing" }
  }
  return { eligible: true, reason: "eligible" }
}

function priorityBucket(priority: number | null): number {
  return Number.isInteger(priority) && priority! >= 1 && priority! <= 4
    ? priority!
    : 5
}

function instant(value: string | null): number {
  if (value === null) return Number.POSITIVE_INFINITY
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY
}

export function compareSchedulableIssues(
  left: SchedulableIssue,
  right: SchedulableIssue,
): number {
  const priority = priorityBucket(left.priority) - priorityBucket(right.priority)
  if (priority !== 0) return priority
  const created = instant(left.created_at) - instant(right.created_at)
  if (created !== 0) return created
  return left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0
}

export function sortSchedulableIssues<T extends SchedulableIssue>(issues: readonly T[]): T[] {
  return [...issues].sort(compareSchedulableIssues)
}
