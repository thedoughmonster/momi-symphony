import type { Sql } from "postgres"

import { getDatabase } from "../../../src/database.ts"
import { buildBoundedReviewerPacket, reduceMergeEligibility, REVIEW_POLICY_VERSION,
  requiresFreshReviewer, selectReviewProfile, type ReviewReceipt } from "../../../src/independent_review.ts"
import { stableFingerprint } from "../../../src/execution_efficiency.ts"
import { reconcileAgentState } from "./agent_state_projection.ts"
import { GitHubReviewGateway } from "./github_review_gateway.ts"
import type { MergePreflightInput, ReviewRequestInput, ReviewStatusInput,
  ReviewTerminalInput } from "./types.ts"

type CreatedAttempt = { disposition: string; review_attempt_id: string | null;
  reviewer_dispatch_id: string | null; reviewer_capability_token: string | null;
  generation: number | null; reviewer_thread_id: string | null }
type ReviewRoute = { url: string; issueId: string; issueIdentifier: string;
  issueUrl: string; projectId: string; projectName: string; activeStates: string[] }
type PriorReview = { review_attempt_id: string; head_sha: string; profile: "low" | "standard" | "high";
  policy_version: string; reviewer_thread_id: string; findings: Array<Record<string, unknown>> }

export async function processReviewRequest(input: ReviewRequestInput,
  sql: Sql = getDatabase(), github = new GitHubReviewGateway(),
  fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const subject = await github.loadSubject(input.repository, input.pull_request_number)
  if (subject.state !== "open" || subject.repository !== input.repository ||
    subject.baseBranch !== input.base_branch) throw new Error("review_subject_mapping_refused")
  const route = await reviewRoute(sql, input.work_id)
  const profile = selectReviewProfile(subject.changedPaths)
  const prior = await priorChangesRequestedReview(sql, input.work_id)
  let reverificationOf: string | null = null
  let reviewChangedPaths = subject.changedPaths
  let reviewDiffArtifactRef = subject.diffArtifactRef
  let unresolvedFindings: Array<{ id: string; path: string; line: number | null;
    required_outcome: string }> = []
  if (prior) {
    const changedPaths = await github.compareChangedPaths(input.repository,
      prior.head_sha, subject.headSha)
    const findingPaths = prior.findings.map((finding) => String(finding.path ?? ""))
    if (!requiresFreshReviewer({ previousProfile: prior.profile, nextProfile: profile,
      priorReviewerAvailable: Boolean(prior.reviewer_thread_id),
      policyChanged: prior.policy_version !== REVIEW_POLICY_VERSION,
      changedPaths, findingPaths, materialRiskChanged: false })) {
      reverificationOf = prior.review_attempt_id
      reviewChangedPaths = changedPaths
      reviewDiffArtifactRef = `https://api.github.com/repos/${input.repository}/compare/${prior.head_sha}...${subject.headSha}`
      unresolvedFindings = prior.findings.map((finding) => ({ id: String(finding.id),
        path: String(finding.path), line: Number.isSafeInteger(finding.line)
          ? Number(finding.line) : null, required_outcome: String(finding.required_outcome) }))
    }
  }
  const packet = buildBoundedReviewerPacket({ subject: {
    implementation_dispatch_id: input.work_id,
    reviewer_dispatch_id: "00000000-0000-4000-8000-000000000000",
    repository: subject.repository, pull_request_number: subject.pullRequestNumber,
    head_sha: subject.headSha, base_sha: subject.baseSha, generation: 1,
    profile, policy_version: REVIEW_POLICY_VERSION,
  }, issue: { identifier: route.issueIdentifier, title: "Bounded Linear implementation issue",
    required_outcome: "Read only the named Linear issue and applicable AGENTS.md rules; perform substantive review of the exact PR subject." },
  applicable_rules: applicableRules(subject.changedPaths),
  changed_paths: reviewChangedPaths, diff_artifact_ref: reviewDiffArtifactRef, ci: [],
  unresolved_findings: unresolvedFindings })
  const packetFingerprint = stableFingerprint(packet)
  const rows = await sql<CreatedAttempt[]>`
    select disposition, review_attempt_id::text, reviewer_dispatch_id::text,
      reviewer_capability_token::text, generation, reviewer_thread_id
    from momi_agent_ops.create_review_attempt_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${input.thread_id}, ${input.turn_id}, ${input.repository}, ${input.base_branch},
      ${input.pull_request_number}, ${subject.headSha}, ${subject.baseSha}, ${profile},
      ${REVIEW_POLICY_VERSION}, ${packetFingerprint}, ${reviewDiffArtifactRef},
      ${reverificationOf}::uuid, 4
    )
  `
  const attempt = rows[0]
  if (!attempt) throw new Error("review_attempt_not_created")
  if (attempt.disposition !== "created") return { ok: true, disposition: attempt.disposition,
    review_attempt_id: attempt.review_attempt_id,
    reviewer_dispatch_id: attempt.reviewer_dispatch_id, generation: attempt.generation }
  if (!attempt.review_attempt_id || !attempt.reviewer_dispatch_id ||
    !attempt.reviewer_capability_token || !attempt.generation) {
    throw new Error("review_attempt_identity_missing")
  }
  const exactPacket = { ...packet, subject: { ...(packet.subject as Record<string, unknown>),
    reviewer_dispatch_id: attempt.reviewer_dispatch_id, generation: attempt.generation } }
  const exactPacketFingerprint = stableFingerprint(exactPacket)
  await sql`update momi_agent_ops.review_attempts set
    packet_fingerprint = ${exactPacketFingerprint}, updated_at = now()
    where review_attempt_id = ${attempt.review_attempt_id}::uuid and state = 'reserved'`
  const prompt = reviewerPrompt(exactPacket, profile, Boolean(attempt.reviewer_thread_id))
  const secret = Deno.env.get("MOMI_CODEX_HOST_SECRET")?.trim() ?? ""
  if (!secret) throw new Error("review_host_secret_unconfigured")
  const hostUrl = new URL(route.url)
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(hostUrl.hostname)
  if ((!loopback && hostUrl.protocol !== "https:") || !hostUrl.pathname.endsWith("/v1/dispatch")) {
    throw new Error("review_host_route_refused")
  }
  const response = await fetchImpl(hostUrl, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ schema_version: 4, work_id: attempt.reviewer_dispatch_id,
      capability_token: attempt.reviewer_capability_token, issue_id: route.issueId,
      issue_identifier: route.issueIdentifier, issue_url: route.issueUrl,
      project_id: route.projectId, project_name: route.projectName, repository: input.repository,
      base_branch: input.base_branch, active_states: route.activeStates,
      interaction_mode: "one_shot", thread_name: `${route.issueIdentifier} · independent review`,
      stable_instruction: prompt.stable, volatile_context: prompt.volatile,
      stable_prefix_fingerprint: stableFingerprint(prompt.stable),
      context_fingerprint: stableFingerprint(exactPacket), policy_version: REVIEW_POLICY_VERSION,
      budget: reviewBudget(profile), runtime_role: "independent_reviewer",
      ...(attempt.reviewer_thread_id ? { review_thread_id: attempt.reviewer_thread_id } : {}),
      review_subject: { implementation_dispatch_id: input.work_id,
        pull_request_number: subject.pullRequestNumber, head_sha: subject.headSha,
        base_sha: subject.baseSha, generation: attempt.generation, profile,
        policy_version: REVIEW_POLICY_VERSION } }), signal: AbortSignal.timeout(10_000) })
  const accepted = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || typeof accepted?.thread_id !== "string" ||
    typeof accepted.turn_id !== "string") throw new Error("review_host_delivery_ambiguous")
  const started = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_reviewer_start_v1(
      ${attempt.reviewer_dispatch_id}::uuid, ${attempt.reviewer_capability_token}::uuid,
      'independent_reviewer', ${accepted.thread_id}, ${accepted.turn_id}
    ) as recorded`
  if (started[0]?.recorded !== true) throw new Error("reviewer_start_record_refused")
  await reconcileAgentState(input.work_id)
  return { ok: true, disposition: "accepted", review_attempt_id: attempt.review_attempt_id,
    reviewer_dispatch_id: attempt.reviewer_dispatch_id, generation: attempt.generation }
}

export async function processReviewStatus(input: ReviewStatusInput,
  sql: Sql = getDatabase()): Promise<Record<string, unknown>> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select state, result, findings, reviewer_dispatch_id::text, head_sha, base_sha,
      generation, profile, policy_version
    from momi_agent_ops.get_review_status_v1(
      ${input.work_id}::uuid, ${input.capability_token}::uuid,
      ${input.thread_id}, ${input.turn_id})`
  if (!rows[0]) throw new Error("review_status_refused")
  return { ok: true, ...rows[0] }
}

export async function processMergePreflight(input: MergePreflightInput,
  sql: Sql = getDatabase(), github = new GitHubReviewGateway()): Promise<Record<string, unknown>> {
  const subject = await github.loadSubject(input.repository, input.pull_request_number)
  const facts = await github.loadMergeFacts(input.repository, input.base_branch,
    input.pull_request_number, subject.headSha)
  const rows = await sql<Array<Record<string, unknown>>>`
    select work.work_status, work.cancellation_requested_at, work.cancelled_at,
      work.codex_thread_id as implementation_thread_id,
      review.implementation_dispatch_id::text, review.reviewer_dispatch_id::text,
      review.repository, review.pull_request_number, review.head_sha, review.base_sha,
      review.generation, review.profile, review.policy_version, review.reviewer_thread_id,
      review.reviewer_turn_id, review.runtime_role, review.result, review.findings,
      review.result_artifact_ref as artifact_ref, review.result_fingerprint
    from momi_agent_ops.dispatches work
    left join momi_agent_ops.run_records run on run.dispatch_id = work.dispatch_id
    left join momi_agent_ops.review_attempts review on review.review_attempt_id = run.review_receipt_id
    where work.dispatch_id = ${input.work_id}::uuid
      and work.host_callback_token_hash = encode(extensions.digest(
        convert_to(${input.capability_token}::uuid::text, 'UTF8'), 'sha256'), 'hex')
      and work.codex_thread_id = ${input.thread_id} and work.codex_turn_id = ${input.turn_id}
      and work.mapped_repository = ${input.repository}
      and work.mapped_base_branch = ${input.base_branch}`
  const row = rows[0]
  if (!row) throw new Error("merge_preflight_identity_refused")
  const receipt = row.reviewer_dispatch_id ? {
    implementation_dispatch_id: row.implementation_dispatch_id,
    reviewer_dispatch_id: row.reviewer_dispatch_id, repository: row.repository,
    pull_request_number: Number(row.pull_request_number), head_sha: row.head_sha,
    base_sha: row.base_sha, generation: Number(row.generation), profile: row.profile,
    policy_version: row.policy_version, reviewer_thread_id: row.reviewer_thread_id,
    reviewer_turn_id: row.reviewer_turn_id, runtime_role: row.runtime_role,
    result: row.result, findings: row.findings, artifact_ref: row.artifact_ref,
    result_fingerprint: row.result_fingerprint } as ReviewReceipt : null
  const lifecycle = row.cancellation_requested_at || row.cancelled_at ? "canceled"
    : ["writeback_pending", "active"].includes(String(row.work_status)) ? "active" : "terminal"
  const decision = reduceMergeEligibility({ lifecycle, repository: input.repository,
    base_branch: input.base_branch,
    pull_request: { exists: true, open: subject.state === "open",
      repository: subject.repository, base_branch: subject.baseBranch,
      head_sha: subject.headSha, base_sha: subject.baseSha },
    required_ci: { head_sha: facts.requiredCi.headSha,
      conclusion: facts.requiredCi.conclusion }, review: receipt,
    review_check: { name: facts.reviewCheck.name, head_sha: facts.reviewCheck.headSha,
      conclusion: facts.reviewCheck.conclusion },
    authoritative_blocking_threads: facts.authoritativeBlockingThreads,
    authoritative_changes_requested: facts.authoritativeChangesRequested,
    branch_protection: { review_check_required: facts.reviewCheckRequired,
      bypass_possible: facts.bypassPossible }, current_policy_version: REVIEW_POLICY_VERSION,
    expected_profile: selectReviewProfile(subject.changedPaths),
    implementation_thread_id: String(row.implementation_thread_id ?? "") })
  if (!decision.eligible) return { ok: true, eligible: false, reason: decision.reason,
    head_sha: subject.headSha, base_sha: subject.baseSha }
  const canonical = await sql<{ eligible: boolean }[]>`
    select momi_agent_ops.merge_review_eligible_v1(
      ${input.work_id}::uuid, ${input.repository}, ${input.base_branch},
      ${input.pull_request_number}, ${subject.headSha}, ${subject.baseSha},
      ${REVIEW_POLICY_VERSION}, ${selectReviewProfile(subject.changedPaths)}) as eligible`
  return canonical[0]?.eligible === true
    ? { ok: true, eligible: true, head_sha: subject.headSha, base_sha: subject.baseSha }
    : { ok: true, eligible: false, reason: "canonical_review_ledger_ineligible",
      head_sha: subject.headSha, base_sha: subject.baseSha }
}

export async function processReviewTerminal(input: ReviewTerminalInput,
  sql: Sql = getDatabase(), github = new GitHubReviewGateway()): Promise<Record<string, unknown>> {
  const result = input.review_result ?? { result: "inconclusive" as const, findings: [],
    artifact_ref: `review://terminal/${input.reviewer_dispatch_id}`,
    result_fingerprint: `sha256:${"0".repeat(64)}` }
  const subject = input.review_subject
  const repository = await routeRepository(subject.implementation_dispatch_id, sql)
  const recorded = await sql<{ recorded: boolean }[]>`
    select momi_agent_ops.record_review_result_v1(
      ${input.reviewer_dispatch_id}::uuid, ${input.capability_token}::uuid,
      ${input.runtime_role}, ${input.thread_id}, ${input.turn_id}, ${repository},
      ${subject.pull_request_number}, ${subject.head_sha}, ${subject.base_sha},
      ${subject.generation}, ${subject.profile}, ${subject.policy_version}, ${result.result},
      ${sql.json(result.findings as never)}::jsonb, ${result.result_fingerprint},
      ${result.artifact_ref}, ${sql.json(input.telemetry)}::jsonb
    ) as recorded`
  if (recorded[0]?.recorded !== true) throw new Error("review_result_record_refused")
  const accepted = result.result === "accepted"
  await github.publishReviewCheck(repository, subject.head_sha, accepted,
    accepted ? "Exact-head independent review accepted" : `Independent review: ${result.result}`)
  if (accepted) {
    const receipt = await latestAcceptedReceipt(subject.implementation_dispatch_id, sql)
    const checked = await sql<{ recorded: boolean }[]>`
      select momi_agent_ops.record_review_check_v1(
        ${subject.implementation_dispatch_id}::uuid, ${receipt}::uuid,
        ${subject.head_sha}, 'Symphony Independent Review', 'success') as recorded`
    if (checked[0]?.recorded !== true) throw new Error("review_check_record_refused")
  }
  await reconcileAgentState(subject.implementation_dispatch_id)
  return { ok: true, disposition: result.result }
}

async function reviewRoute(sql: Sql, dispatchId: string): Promise<ReviewRoute> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select mapping.host_dispatch_url, work.linear_issue_id::text as issue_id,
      work.linear_issue_identifier as issue_identifier, work.linear_issue_url as issue_url,
      work.linear_project_id::text as project_id, work.linear_project_name as project_name,
      work.active_states
    from momi_agent_ops.dispatches work
    join momi_agent_ops.project_mappings mapping
      on mapping.linear_project_id = work.linear_project_id and mapping.active
      and mapping.repository = work.mapped_repository
      and mapping.base_branch = work.mapped_base_branch
    where work.dispatch_id = ${dispatchId}::uuid`
  const row = rows[0]
  if (!row || typeof row.host_dispatch_url !== "string" ||
    typeof row.issue_id !== "string" || typeof row.issue_identifier !== "string" ||
    typeof row.issue_url !== "string" || typeof row.project_id !== "string" ||
    typeof row.project_name !== "string" || !Array.isArray(row.active_states)) {
    throw new Error("review_route_missing")
  }
  return { url: row.host_dispatch_url, issueId: row.issue_id,
    issueIdentifier: row.issue_identifier, issueUrl: row.issue_url,
    projectId: row.project_id, projectName: row.project_name,
    activeStates: row.active_states as string[] }
}

async function routeRepository(dispatchId: string, sql: Sql): Promise<string> {
  const rows = await sql<{ repository: string }[]>`
    select mapped_repository as repository from momi_agent_ops.dispatches
    where dispatch_id = ${dispatchId}::uuid`
  if (!rows[0]?.repository) throw new Error("review_repository_missing")
  return rows[0].repository
}

async function latestAcceptedReceipt(dispatchId: string, sql: Sql): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select review_attempt_id::text as id from momi_agent_ops.review_attempts
    where implementation_dispatch_id = ${dispatchId}::uuid and state = 'accepted'
    order by generation desc limit 1`
  if (!rows[0]?.id) throw new Error("accepted_review_receipt_missing")
  return rows[0].id
}

function reviewerPrompt(packet: Record<string, unknown>, profile: string,
  reverification: boolean): {
  stable: string; volatile: string } {
  return { stable: [
    reverification
      ? "Continue only as the same independent reviewer for a mechanically bounded finding correction."
      : "Act only as a fresh independent substantive pull-request reviewer.",
    "Do not edit files, push, merge, release, change policy, or invoke Symphony.",
    "Inspect only the exact revision-bound packet and narrowly necessary referenced files.",
    "Do not request or use the implementation transcript, author reasoning, or sibling-review prose.",
    "Return accepted, changes_requested, inconclusive, or escalate with compact typed findings.",
    "Acceptance is forbidden when any blocking finding remains.",
  ].join("\n"), volatile: `Review mode: ${reverification ? "bounded_reverification" : "fresh"}\nReview profile: ${profile}\nExact reviewer packet:\n${JSON.stringify(packet)}` }
}

function reviewBudget(profile: string): Record<string, number> {
  if (profile === "low") return { model_turns: 4, no_progress_cycles: 1, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 24_000, elapsed_ms: 900_000 }
  if (profile === "standard") return { model_turns: 8, no_progress_cycles: 2, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 48_000, elapsed_ms: 1_800_000 }
  return { model_turns: 16, no_progress_cycles: 2, subagents: 0,
    subagent_depth: 0, model_visible_tool_bytes: 96_000, elapsed_ms: 3_600_000 }
}

function applicableRules(paths: string[]): Array<{ path: string; fingerprint: string }> {
  const rules = new Set(["AGENTS.md"])
  if (paths.some((path) => path.startsWith("services/agent-control/"))) {
    rules.add("services/agent-control/AGENTS.md")
  }
  if (paths.some((path) => path.startsWith("services/agent-control-host/"))) {
    rules.add("services/agent-control-host/AGENTS.md")
  }
  return [...rules].sort().map((path) => ({ path, fingerprint: stableFingerprint(path) }))
}

async function priorChangesRequestedReview(sql: Sql,
  dispatchId: string): Promise<PriorReview | null> {
  const rows = await sql<PriorReview[]>`
    select review_attempt_id::text, head_sha, profile, policy_version,
      reviewer_thread_id, findings
    from momi_agent_ops.review_attempts
    where implementation_dispatch_id = ${dispatchId}::uuid
      and state = 'changes_requested' and reviewer_thread_id is not null
    order by generation desc limit 1`
  return rows[0] ?? null
}
