import assert from "node:assert/strict"
import test from "node:test"

import {
  compareSchedulableIssues,
  schedulerEligibility,
  sortSchedulableIssues,
  type SchedulableIssue,
} from "../../../src/scheduler_policy.ts"

const policy = { activeStates: ["Todo", "In Progress"],
  requiredLabels: ["ready-package"] }

function issue(overrides: Partial<SchedulableIssue> = {}): SchedulableIssue {
  return { id: "issue-1", identifier: "MOX-1", title: "Leaf", state: "Todo",
    priority: 2, created_at: "2026-08-19T00:00:00.000Z",
    url: "https://linear.app/mox/issue/MOX-1/leaf",
    labels: ["ready-package"], dispatchable: true, ...overrides }
}

test("scheduler eligibility is table-driven and consumes normalized dispatchable", () => {
  const fixtures: Array<[string, SchedulableIssue, boolean, string]> = [
    ["ready leaf", issue(), true, "eligible"],
    ["parent/non-leaf", issue({ dispatchable: false }), false, "adapter_unroutable"],
    ["dependency blocked leaf", issue({ dispatchable: false }), false, "adapter_unroutable"],
    ["inactive state", issue({ state: "Backlog" }), false, "inactive_state"],
    ["required label miss", issue({ labels: [] }), false,
      "required_label_missing"],
    ["missing canonical URL", issue({ url: null }), false, "invalid_issue_url"],
  ]
  for (const [name, candidate, eligible, reason] of fixtures) {
    const result = schedulerEligibility(candidate, policy)
    assert.equal(result.eligible, eligible, name)
    assert.equal(result.reason, reason, name)
  }
})

test("issue comparator exactly follows priority, creation time, and identifier", () => {
  const candidates = [
    issue({ identifier: "MOX-9", priority: null, created_at: "2026-01-01T00:00:00Z" }),
    issue({ identifier: "MOX-8", priority: 0, created_at: "2025-01-01T00:00:00Z" }),
    issue({ identifier: "MOX-7", priority: 5, created_at: "2024-01-01T00:00:00Z" }),
    issue({ identifier: "MOX-6", priority: 4, created_at: null }),
    issue({ identifier: "MOX-5", priority: 4, created_at: "2026-01-01T00:00:00Z" }),
    issue({ identifier: "MOX-4", priority: 3, created_at: "2026-01-01T00:00:00Z" }),
    issue({ identifier: "MOX-3", priority: 2, created_at: "2026-01-01T00:00:00Z" }),
    issue({ identifier: "MOX-2", priority: 1, created_at: "2026-01-02T00:00:00Z" }),
    issue({ identifier: "MOX-1", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
    issue({ identifier: "MOX-0", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
  ]
  assert.deepEqual(sortSchedulableIssues(candidates).map(({ identifier }) => identifier), [
    "MOX-0", "MOX-1", "MOX-2", "MOX-3", "MOX-4", "MOX-5", "MOX-6",
    "MOX-7", "MOX-8", "MOX-9",
  ])
  assert.equal(compareSchedulableIssues(issue({ identifier: "A" }),
    issue({ identifier: "B" })), -1)
})
