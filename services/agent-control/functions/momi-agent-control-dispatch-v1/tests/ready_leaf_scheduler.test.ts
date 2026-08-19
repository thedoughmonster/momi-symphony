import assert from "node:assert/strict"
import test from "node:test"

import { LinearAdapterError, type NormalizedLinearIssue } from "../src/linear_issue_adapter.ts"
import { LinearGraphqlError } from "../src/linear_graphql.ts"
import { processReadyLeafSchedulerPump,
  type ReadyLeafSchedulerDependencies } from "../src/ready_leaf_scheduler.ts"
import type { SchedulerCandidate, SchedulerRoute } from "../src/scheduler_database.ts"

const owner = "00000000-0000-4000-8000-000000000001"
const project = "00000000-0000-4000-8000-000000000002"
const releaseSha = "a".repeat(40)

const route: SchedulerRoute = {
  routeKey: "thedoughmonster/momi-symphony@main|https://host.example/v1/dispatch",
  projectId: project,
  teamId: null,
  repository: "thedoughmonster/momi-symphony",
  baseBranch: "main",
  hostDispatchUrl: "https://host.example/v1/dispatch",
  activeStates: ["Todo", "In Progress", "Rework"],
  requiredLabels: ["implementation", "ready-package"],
  mode: "enabled",
  acceptanceIssueIds: [],
}

function normalized(index: number, overrides: Partial<NormalizedLinearIssue> = {}): NormalizedLinearIssue {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
  const identifier = `MOX-${index}`
  return {
    id,
    native_ref: { provider: "linear", issue_id: id, project_id: project, team_id: null,
      repository: route.repository, base_branch: route.baseBranch,
      hierarchy_mode: "native_child", parent: null, sub_issues: [],
      sub_issues_complete: true, parent_progress: null },
    identifier,
    title: `Issue ${index}`,
    description: "## 10. Acceptance criteria\n- complete",
    priority: 2,
    state: "Todo",
    branch_name: null,
    url: `https://linear.app/mox/issue/${identifier}/issue`,
    assignee_id: null,
    labels: ["implementation", "ready-package"],
    blocked_by: [],
    dispatchable: true,
    dispatchability_reasons: [],
    created_at: `2026-08-19T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    updated_at: "2026-08-19T01:00:00.000Z",
    ...overrides,
  }
}

function dependencies(options: {
  issues: Map<string, NormalizedLinearIssue>
  mode?: SchedulerRoute["mode"]
  acceptanceIssueIds?: string[]
  capacity?: number
  fetchFailure?: boolean
  refreshFailure?: LinearGraphqlError
}) {
  const dispatched = new Set<string>()
  const active = new Set<string>()
  const snapshots = new Map<string, number>()
  const generations = new Map<string, number>()
  const lastEligible = new Map<string, boolean>()
  const retryCodes: string[] = []
  let maxActive = 0
  const selectedRoute = { ...route, mode: options.mode ?? "enabled",
    acceptanceIssueIds: options.acceptanceIssueIds ?? [] }
  const deps: ReadyLeafSchedulerDependencies = {
    routes: () => Promise.resolve([selectedRoute]),
    acquireLeader: () => Promise.resolve({ routeKey: route.routeKey, generation: 1 }),
    fetchCandidates: () => options.fetchFailure
      ? Promise.reject(new LinearAdapterError("tracker_response", "provider_down"))
      : Promise.resolve([...options.issues.values()]),
    refresh: (_route, ids) => options.refreshFailure
      ? Promise.reject(options.refreshFailure)
      : Promise.resolve(ids.flatMap((id) => {
      const issue = options.issues.get(id); return issue ? [issue] : []
      })),
    candidateIds: () => Promise.resolve([...options.issues.keys()]),
    reconcile: (_route, issue) => {
      const previous = lastEligible.get(issue.id) ?? false
      if (issue.dispatchable && !previous) {
        generations.set(issue.id, (generations.get(issue.id) ?? 0) + 1)
      }
      lastEligible.set(issue.id, issue.dispatchable)
      const snapshot = (snapshots.get(issue.id) ?? 0) + 1
      snapshots.set(issue.id, snapshot)
      const candidate: SchedulerCandidate = {
        candidateId: issue.id,
        generation: generations.get(issue.id) ?? 0,
        generationState: dispatched.has(issue.id) ? "running"
          : issue.dispatchable ? "eligible" : previous ? "stale" : "waiting",
        snapshotVersion: snapshot,
        schedulerEligible: issue.dispatchable,
      }
      return Promise.resolve(candidate)
    },
    stale: () => Promise.resolve(true),
    claim: async (_route, _owner, _releaseSha, _leader, candidate) => {
      if (dispatched.has(candidate.candidateId) ||
        active.size >= (options.capacity ?? 20)) return false
      dispatched.add(candidate.candidateId)
      active.add(candidate.candidateId)
      maxActive = Math.max(maxActive, active.size)
      return true
    },
    heartbeat: () => Promise.resolve(),
    providerRetry: (_routeKey, code) => { retryCodes.push(code); return Promise.resolve() },
    providerSuccess: () => Promise.resolve(),
  }
  return { deps, dispatched, active, retryCodes, maxActive: () => maxActive }
}

test("blocked leaf consumes no task or slot and later unblocks without a state change", async () => {
  const leafA = normalized(1)
  const leafB = normalized(2, { dispatchable: false,
    dispatchability_reasons: ["blocker_not_accepted"], blocked_by: [
      { id: leafA.id, identifier: leafA.identifier, state: "In Progress" },
    ] })
  const issues = new Map([[leafA.id, leafA], [leafB.id, leafB]])
  const dependentPackage = { state: leafB.state, labels: [...leafB.labels] }
  const fixture = dependencies({ issues, capacity: 2 })
  const first = await processReadyLeafSchedulerPump({ event: "scheduler_pump",
    scheduler_id: owner, release_sha: releaseSha, active_work_ids: [] }, fixture.deps)
  assert.equal(first.claimed, 1)
  assert.deepEqual([...fixture.dispatched], [leafA.id])

  issues.set(leafB.id, { ...leafB, dispatchable: true,
    dispatchability_reasons: [], blocked_by: [
      { id: leafA.id, identifier: leafA.identifier, state: "Done" },
    ] })
  fixture.active.delete(leafA.id)
  const second = await processReadyLeafSchedulerPump({ event: "scheduler_pump",
    scheduler_id: owner, release_sha: releaseSha, active_work_ids: [] }, fixture.deps)
  assert.equal(second.claimed, 1)
  assert.deepEqual({ state: issues.get(leafB.id)?.state,
    labels: issues.get(leafB.id)?.labels }, dependentPackage)
  assert.equal(fixture.dispatched.has(leafB.id), true)
})

test("observe acceptance is allowlisted and structurally cannot claim", async () => {
  const candidate = normalized(3)
  const fixture = dependencies({ issues: new Map([[candidate.id, candidate]]),
    mode: "observe", acceptanceIssueIds: [candidate.id] })
  const receipt = await processReadyLeafSchedulerPump({ event: "scheduler_pump",
    scheduler_id: owner, release_sha: releaseSha, active_work_ids: [] }, fixture.deps)
  assert.deepEqual(receipt, { ok: true, routes: 1, observed: 1, claimed: 0,
    technical_retries: 0 })
  assert.equal(fixture.dispatched.size, 0)
})

test("provider outage fails closed as technical retry without a claim", async () => {
  const candidate = normalized(4)
  const fixture = dependencies({ issues: new Map([[candidate.id, candidate]]),
    fetchFailure: true })
  const receipt = await processReadyLeafSchedulerPump({ event: "scheduler_pump",
    scheduler_id: owner, release_sha: releaseSha, active_work_ids: [] }, fixture.deps)
  assert.equal(receipt.technical_retries, 1)
  assert.equal(receipt.claimed, 0)
  assert.deepEqual(fixture.retryCodes, ["tracker_response"])
})

test("observe mode preserves a bounded typed tracker failure in its count-only receipt", async () => {
  const candidate = normalized(5)
  const fixture = dependencies({ issues: new Map([[candidate.id, candidate]]),
    mode: "observe", acceptanceIssueIds: [candidate.id],
    refreshFailure: new LinearGraphqlError("tracker_timeout") })
  const receipt = await processReadyLeafSchedulerPump({ event: "scheduler_pump",
    scheduler_id: owner, release_sha: releaseSha, active_work_ids: [] }, fixture.deps)
  assert.deepEqual(receipt, { ok: true, routes: 1, observed: 0, claimed: 0,
    technical_retries: 1 })
  assert.deepEqual(fixture.retryCodes, ["tracker_timeout"])
})

test("twenty candidates drain within capacity across terminal refills", async () => {
  const issues = new Map(Array.from({ length: 20 }, (_, index) => {
    const candidate = normalized(index + 10, { priority: (index % 4) + 1 })
    return [candidate.id, candidate]
  }))
  const fixture = dependencies({ issues, capacity: 3 })
  while (fixture.dispatched.size < 20) {
    await processReadyLeafSchedulerPump({ event: "scheduler_pump",
      scheduler_id: owner, release_sha: releaseSha,
      active_work_ids: [...fixture.active] }, fixture.deps)
    assert.ok(fixture.active.size <= 3)
    const released = fixture.active.values().next().value as string | undefined
    if (!released) assert.fail("scheduler failed to fill an available slot")
    fixture.active.delete(released)
  }
  assert.equal(fixture.dispatched.size, 20)
  assert.equal(fixture.maxActive(), 3)
})

test("duplicate and concurrent pumps cannot duplicate a claim", async () => {
  const candidate = normalized(40)
  const fixture = dependencies({ issues: new Map([[candidate.id, candidate]]), capacity: 1 })
  await Promise.all(Array.from({ length: 5 }, () =>
    processReadyLeafSchedulerPump({ event: "scheduler_pump",
      scheduler_id: owner, release_sha: releaseSha, active_work_ids: [] }, fixture.deps)))
  assert.equal(fixture.dispatched.size, 1)
  assert.equal(fixture.active.size, 1)
})
