import { schedulerEligibility, sortSchedulableIssues } from "../../../src/scheduler_policy.ts"
import { createLinearAdapterProfile, LinearAdapterError } from "./linear_issue_adapter.ts"
import { LinearGraphqlError } from "./linear_graphql.ts"
import { fetchLinearCandidateIssues, refreshLinearIssues } from "./linear_issue_reader.ts"
import {
  acquireSchedulerLeader,
  claimSchedulerCandidate,
  heartbeatSchedulerSlots,
  listSchedulerCandidateIds,
  listProjectableAgentStateDispatchIds,
  listSchedulerRoutes,
  markSchedulerCandidateStale,
  reconcileSchedulerCandidate,
  recordSchedulerProviderRetry,
  recordSchedulerProviderSuccess,
  type SchedulerCandidate,
  type SchedulerClaim,
  type SchedulerLeader,
  type SchedulerRoute,
} from "./scheduler_database.ts"
import { reconcileAgentState } from "./agent_state_projection.ts"
import type { NormalizedLinearIssue } from "./linear_issue_adapter.ts"
import type { SchedulerPumpInput } from "./types.ts"
import { listDueTerminalProjectionIds, processTerminalProjection } from "./terminal_projection.ts"
import type { TerminalProjectionResult } from "./terminal_projection.ts"

export type ReadyLeafSchedulerDependencies = {
  routes: () => Promise<SchedulerRoute[]>
  acquireLeader: (routeKey: string, ownerId: string,
    releaseSha: string) => Promise<SchedulerLeader | null>
  fetchCandidates: (route: SchedulerRoute) => Promise<NormalizedLinearIssue[]>
  refresh: (route: SchedulerRoute, issueIds: readonly string[]) => Promise<NormalizedLinearIssue[]>
  candidateIds: (route: SchedulerRoute) => Promise<string[]>
  projectable: (route: SchedulerRoute) => Promise<string[]>
  reconcile: (route: SchedulerRoute, issue: NormalizedLinearIssue) => Promise<SchedulerCandidate>
  stale: (route: SchedulerRoute, issueId: string) => Promise<boolean>
  claim: (route: SchedulerRoute, ownerId: string, releaseSha: string,
    leader: SchedulerLeader,
    candidate: SchedulerCandidate) => Promise<SchedulerClaim | null>
  project: (dispatchId: string) => Promise<unknown>
  projectionIds: (route: SchedulerRoute) => Promise<string[]>
  replayProjection: (dispatchId: string) => Promise<TerminalProjectionResult>
  heartbeat: (activeWorkIds: readonly string[]) => Promise<void>
  providerRetry: (routeKey: string, errorCode: string) => Promise<void>
  providerSuccess: (routeKey: string) => Promise<void>
}

export type ReadyLeafSchedulerReceipt = {
  ok: true
  routes: number
  observed: number
  claimed: number
  technical_retries: number
  projection_retries: number
  projection_failures: number
}

function adapterProfile(route: SchedulerRoute) {
  return createLinearAdapterProfile({
    projectId: route.projectId,
    teamId: route.teamId,
    repository: route.repository,
    baseBranch: route.baseBranch,
  })
}

function defaultDependencies(): ReadyLeafSchedulerDependencies {
  return {
    routes: listSchedulerRoutes,
    acquireLeader: acquireSchedulerLeader,
    fetchCandidates: (route) => fetchLinearCandidateIssues(
      route.activeStates,
      adapterProfile(route),
    ),
    refresh: (route, issueIds) => refreshLinearIssues(issueIds, adapterProfile(route)),
    candidateIds: listSchedulerCandidateIds,
    projectable: listProjectableAgentStateDispatchIds,
    reconcile: reconcileSchedulerCandidate,
    stale: markSchedulerCandidateStale,
    claim: claimSchedulerCandidate,
    project: reconcileAgentState,
    projectionIds: listDueTerminalProjectionIds,
    replayProjection: processTerminalProjection,
    heartbeat: heartbeatSchedulerSlots,
    providerRetry: recordSchedulerProviderRetry,
    providerSuccess: recordSchedulerProviderSuccess,
  }
}

function technicalCode(error: unknown): string {
  if (error instanceof LinearGraphqlError) return error.code
  return error instanceof LinearAdapterError ? error.category : "tracker_request"
}

async function reconcileCompleteRefresh(
  route: SchedulerRoute,
  requestedIds: readonly string[],
  refreshed: readonly NormalizedLinearIssue[],
  dependencies: ReadyLeafSchedulerDependencies,
): Promise<Map<string, { issue: NormalizedLinearIssue; candidate: SchedulerCandidate }>> {
  const byId = new Map(refreshed.map((issue) => [issue.id, issue]))
  for (const missing of requestedIds.filter((id) => !byId.has(id))) {
    await dependencies.stale(route, missing)
  }
  const result = new Map<string, { issue: NormalizedLinearIssue; candidate: SchedulerCandidate }>()
  for (const issue of refreshed) {
    result.set(issue.id, { issue, candidate: await dependencies.reconcile(route, issue) })
  }
  return result
}

async function processObservedRoute(
  route: SchedulerRoute,
  dependencies: ReadyLeafSchedulerDependencies,
): Promise<number> {
  const refreshed = await dependencies.refresh(route, route.acceptanceIssueIds)
  await reconcileCompleteRefresh(route, route.acceptanceIssueIds, refreshed, dependencies)
  return refreshed.length
}

async function processEnabledRoute(
  route: SchedulerRoute,
  ownerId: string,
  releaseSha: string,
  leader: SchedulerLeader,
  dependencies: ReadyLeafSchedulerDependencies,
): Promise<{ observed: number; claimed: number }> {
  const fetched = await dependencies.fetchCandidates(route)
  for (const issue of fetched) await dependencies.reconcile(route, issue)

  const known = await dependencies.candidateIds(route)
  const ids = [...new Set([...fetched.map((issue) => issue.id), ...known])]
  const refreshed = ids.length === 0 ? [] : await dependencies.refresh(route, ids)
  const current = await reconcileCompleteRefresh(route, ids, refreshed, dependencies)
  let claimed = 0
  const ordered = sortSchedulableIssues(
    [...current.values()].map(({ issue }) => issue),
  )
  for (const issue of ordered) {
    if (!schedulerEligibility(issue, route).eligible) continue
    const immediate = await dependencies.refresh(route, [issue.id])
    if (immediate.length !== 1 || immediate[0].id !== issue.id) {
      await dependencies.stale(route, issue.id)
      continue
    }
    const fresh = immediate[0]
    if (!schedulerEligibility(fresh, route).eligible) {
      await dependencies.reconcile(route, fresh)
      continue
    }
    const candidate = await dependencies.reconcile(route, fresh)
    if (candidate.generationState !== "eligible" || !candidate.schedulerEligible) continue
    const claim = await dependencies.claim(
      route, ownerId, releaseSha, leader, candidate,
    )
    if (claim) {
      claimed += 1
      await dependencies.project(claim.dispatchId)
    }
  }
  return { observed: fetched.length, claimed }
}

export async function processReadyLeafSchedulerPump(
  input: SchedulerPumpInput,
  dependencies: ReadyLeafSchedulerDependencies = defaultDependencies(),
): Promise<ReadyLeafSchedulerReceipt> {
  await dependencies.heartbeat(input.active_work_ids)
  const routes = await dependencies.routes()
  let observed = 0
  let claimed = 0
  let technicalRetries = 0
  let projectionRetries = 0
  let projectionFailures = 0
  for (const route of routes) {
    const leader = await dependencies.acquireLeader(
      route.routeKey, input.scheduler_id, input.release_sha,
    )
    if (!leader) continue
    try {
      if (route.mode === "observe") {
        observed += await processObservedRoute(route, dependencies)
      } else {
        const receipt = await processEnabledRoute(
          route, input.scheduler_id, input.release_sha, leader, dependencies,
        )
        observed += receipt.observed
        claimed += receipt.claimed
      }
      for (const dispatchId of await dependencies.projectionIds(route)) {
        const projection = await dependencies.replayProjection(dispatchId)
        if (projection.claimed) projectionRetries += 1
        if (projection.status === "failed" || projection.status === "retryable") {
          projectionFailures += 1
        }
      }
      for (const dispatchId of await dependencies.projectable(route)) {
        await dependencies.project(dispatchId)
      }
      await dependencies.providerSuccess(route.routeKey)
    } catch (error) {
      technicalRetries += 1
      await dependencies.providerRetry(route.routeKey, technicalCode(error))
    }
  }
  return { ok: true, routes: routes.length, observed, claimed,
    technical_retries: technicalRetries, projection_retries: projectionRetries,
    projection_failures: projectionFailures }
}
