import { REVIEW_CHECK_NAME, reviewRiskDimensions,
  type ReviewChangedHunk, type ReviewRiskDimension } from "../../../src/independent_review.ts"
import { stableFingerprint } from "../../../src/execution_efficiency.ts"

export type GitHubReviewSubject = {
  repository: string
  pullRequestNumber: number
  state: "open" | "closed"
  baseBranch: string
  headSha: string
  baseSha: string
  changedPaths: string[]
  riskDimensions: ReviewRiskDimension[]
  diffArtifactRef: string
}

export type GitHubCorrectionDelta = { changedPaths: string[];
  changedHunks: ReviewChangedHunk[];
  riskDimensions: ReviewRiskDimension[] }

export type GitHubMergeFacts = {
  baseHeadSha: string
  requiredCi: { headSha: string; conclusion: "success" | "pending" | "failure" | "unknown" }
  reviewCheck: { name: string; headSha: string; conclusion: "success" | "pending" | "failure" | "unknown" }
  reviewCheckRequired: boolean
  bypassPossible: boolean
  authoritativeBlockingThreads: number
  authoritativeChangesRequested: boolean
}

export class GitHubReviewGateway {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly publisher: string
  private readonly appId: number
  constructor(fetchImpl: typeof fetch = fetch,
    token = Deno.env.get("MOMI_GITHUB_REVIEW_TOKEN")?.trim() ?? "",
    publisher = Deno.env.get("MOMI_GITHUB_REVIEW_PUBLISHER")?.trim() ?? "",
    appId = Number(Deno.env.get("MOMI_GITHUB_REVIEW_APP_ID")?.trim() ?? "")) {
    if (!token || !publisher || !Number.isSafeInteger(appId) || appId < 1) {
      throw new Error("github_review_credential_unconfigured")
    }
    this.token = token; this.fetchImpl = fetchImpl; this.publisher = publisher; this.appId = appId
  }

  async loadSubject(repository: string, pullRequestNumber: number): Promise<GitHubReviewSubject> {
    const pr = await this.request<Record<string, unknown>>(
      `/repos/${repository}/pulls/${pullRequestNumber}`)
    const head = object(pr.head); const base = object(pr.base)
    const headSha = text(head.sha); const baseSha = text(base.sha)
    const baseBranch = text(base.ref)
    if (!/^[0-9a-f]{40}$/.test(headSha) || !/^[0-9a-f]{40}$/.test(baseSha) ||
      !/^[A-Za-z0-9._/-]+$/.test(baseBranch) || !["open", "closed"].includes(String(pr.state))) {
      throw new Error("github_pull_request_malformed")
    }
    const files: Array<Record<string, unknown>> = []
    for (let page = 1; page <= 4; page += 1) {
      const batch = await this.request<Array<Record<string, unknown>>>(
        `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`)
      files.push(...batch)
      if (batch.length < 100) break
      if (page === 4) throw new Error("review_diff_too_large")
    }
    const changedPaths = files.map((file) => text(file.filename))
    if (changedPaths.length === 0 || changedPaths.some((path) => !path)) {
      throw new Error("review_diff_empty_or_malformed")
    }
    const riskDimensions = reviewRiskDimensions(files.map((file) => ({
      path: text(file.filename), patch: typeof file.patch === "string" ? file.patch : null,
    })))
    return { repository, pullRequestNumber, state: pr.state as "open" | "closed",
      baseBranch, headSha, baseSha, changedPaths, riskDimensions,
      diffArtifactRef: `https://api.github.com/repos/${repository}/compare/${baseSha}...${headSha}` }
  }

  async loadMergeFacts(repository: string, baseBranch: string,
    pullRequestNumber: number, headSha: string): Promise<GitHubMergeFacts> {
    const [checks, statuses, branch, protection, reviews, threads, rulesetBypass] = await Promise.all([
      this.request<Record<string, unknown>>(`/repos/${repository}/commits/${headSha}/check-runs`),
      this.request<Array<Record<string, unknown>>>(`/repos/${repository}/commits/${headSha}/statuses`),
      this.request<Record<string, unknown>>(
        `/repos/${repository}/branches/${encodeURIComponent(baseBranch)}`),
      this.request<Record<string, unknown>>(
        `/repos/${repository}/branches/${encodeURIComponent(baseBranch)}/protection`),
      this.loadReviews(repository, pullRequestNumber),
      this.loadReviewThreads(repository, pullRequestNumber).catch(() => null),
      this.loadRulesetBypass(repository).catch(() => null),
    ])
    const runs = Array.isArray(checks.check_runs) ? checks.check_runs as Array<Record<string, unknown>> : []
    const reviewCheck = conclusion(runs.filter((run) => run.name === REVIEW_CHECK_NAME &&
      Number(object(run.app).id) === this.appId &&
      text(object(run.app).slug) === this.publisher))
    const required = object(protection.required_status_checks)
    const requiredChecks = Array.isArray(required.checks)
      ? required.checks as Array<Record<string, unknown>> : []
    const boundContexts = new Set(requiredChecks.map((check) => text(check.context)))
    const bareRequiredContexts = [...new Set((Array.isArray(required.contexts)
      ? required.contexts : []).map(String))].filter((name) =>
      name !== REVIEW_CHECK_NAME && !boundContexts.has(name))
    const boundRequiredChecks = requiredChecks.filter((check) =>
      check.context !== REVIEW_CHECK_NAME)
    const enforceAdmins = object(protection.enforce_admins)
    const pullRequestReviews = object(protection.required_pull_request_reviews)
    const bypassAllowances = object(pullRequestReviews.bypass_pull_request_allowances)
    const latestReviewByAuthor = new Map<string, string>()
    for (const review of reviews.sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))) {
      const login = text(object(review.user).login)
      if (login) latestReviewByAuthor.set(login, String(review.state ?? "").toUpperCase())
    }
    const baseHeadSha = text(object(branch.commit).sha)
    if (!/^[0-9a-f]{40}$/.test(baseHeadSha)) throw new Error("github_base_branch_malformed")
    return { baseHeadSha, requiredCi: { headSha,
      conclusion: requiredConclusion(bareRequiredContexts, boundRequiredChecks, runs, statuses) },
      reviewCheck: { name: REVIEW_CHECK_NAME, headSha, conclusion: reviewCheck },
      reviewCheckRequired: required.strict === true && requiredChecks.some((check) =>
        check.context === REVIEW_CHECK_NAME && Number(check.app_id) === this.appId),
      bypassPossible: object(protection.allow_force_pushes).enabled === true ||
        object(protection.allow_deletions).enabled === true || enforceAdmins.enabled !== true ||
        hasBypassActors(bypassAllowances) || rulesetBypass !== false,
      authoritativeBlockingThreads: threads === null ? -1 : threads,
      authoritativeChangesRequested: [...latestReviewByAuthor.values()]
        .some((state) => state === "CHANGES_REQUESTED") }
  }

  async compareChangedPaths(repository: string, previousSha: string,
    nextSha: string): Promise<string[]> {
    return (await this.loadCorrectionDelta(repository, previousSha, nextSha)).changedPaths
  }

  async loadCorrectionDelta(repository: string, previousSha: string,
    nextSha: string): Promise<GitHubCorrectionDelta> {
    if (![previousSha, nextSha].every((sha) => /^[0-9a-f]{40}$/.test(sha))) {
      throw new Error("review_compare_revision_invalid")
    }
    const comparison = await this.request<Record<string, unknown>>(
      `/repos/${repository}/compare/${previousSha}...${nextSha}`)
    const files = Array.isArray(comparison.files)
      ? comparison.files as Array<Record<string, unknown>> : []
    const paths = files.map((file) => text(file.filename))
    if (paths.length === 0 || paths.length > 300 || paths.some((path) => !path)) {
      throw new Error("review_compare_unbounded_or_empty")
    }
    const changedHunks: GitHubCorrectionDelta["changedHunks"] = []
    for (const file of files) {
      const path = text(file.filename)
      if (typeof file.patch !== "string") return { changedPaths: paths, changedHunks: [],
        riskDimensions: ["ambiguous"] }
      changedHunks.push(...parseChangedHunks(path, file.patch))
    }
    if (changedHunks.length === 0) return { changedPaths: paths, changedHunks,
      riskDimensions: ["ambiguous"] }
    return { changedPaths: paths, changedHunks,
      riskDimensions: reviewRiskDimensions(files.map((file) => ({ path: text(file.filename),
        patch: String(file.patch) }))) }
  }

  async loadHeadChecks(repository: string, headSha: string): Promise<Array<{
    name: string; conclusion: string; head_sha: string }>> {
    const [checks, statuses] = await Promise.all([
      this.request<Record<string, unknown>>(`/repos/${repository}/commits/${headSha}/check-runs`),
      this.request<Array<Record<string, unknown>>>(`/repos/${repository}/commits/${headSha}/statuses`),
    ])
    const runs = Array.isArray(checks.check_runs)
      ? checks.check_runs as Array<Record<string, unknown>> : []
    const names = new Set([
      ...runs.map((run) => text(run.name)), ...statuses.map((status) => text(status.context)),
    ].filter(Boolean))
    if (names.size === 0 || names.size > 100) throw new Error("github_head_checks_unbounded")
    return [...names].sort().map((name) => ({ name,
      conclusion: conclusion([
        ...runs.filter((run) => run.name === name),
        ...statuses.filter((status) => status.context === name),
      ]), head_sha: headSha }))
  }

  async loadApplicableRules(repository: string, protectedRevisionSha: string,
    changedPaths: string[]): Promise<Array<{ path: string; fingerprint: string }>> {
    if (!/^[0-9a-f]{40}$/.test(protectedRevisionSha)) {
      throw new Error("review_rules_revision_invalid")
    }
    const candidates = new Set(["AGENTS.md"])
    for (const changedPath of changedPaths) {
      const parts = changedPath.split("/").slice(0, -1)
      for (let depth = 1; depth <= parts.length; depth += 1) {
        candidates.add(`${parts.slice(0, depth).join("/")}/AGENTS.md`)
      }
    }
    const rules: Array<{ path: string; fingerprint: string }> = []
    for (const path of [...candidates].sort()) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/")
      let payload: Record<string, unknown>
      try {
        payload = await this.request<Record<string, unknown>>(
          `/repos/${repository}/contents/${encodedPath}?ref=${protectedRevisionSha}`)
      } catch (error) {
        if (error instanceof Error && error.message.endsWith(":404")) continue
        throw error
      }
      const encoded = text(payload.content).replace(/\s/g, "")
      if (payload.encoding !== "base64" || !encoded) throw new Error("review_rule_malformed")
      let content: string
      try { content = atob(encoded) } catch { throw new Error("review_rule_malformed") }
      rules.push({ path, fingerprint: stableFingerprint(content) })
    }
    if (!rules.some((rule) => rule.path === "AGENTS.md")) {
      throw new Error("review_root_rule_missing")
    }
    return rules
  }

  private async loadReviews(repository: string,
    pullRequestNumber: number): Promise<Array<Record<string, unknown>>> {
    const reviews: Array<Record<string, unknown>> = []
    for (let page = 1; page <= 10; page += 1) {
      const batch = await this.request<Array<Record<string, unknown>>>(
        `/repos/${repository}/pulls/${pullRequestNumber}/reviews?per_page=100&page=${page}`)
      reviews.push(...batch)
      if (batch.length < 100) return reviews
    }
    throw new Error("github_reviews_unbounded")
  }

  private async loadRulesetBypass(repository: string): Promise<boolean> {
    const summaries = await this.request<Array<Record<string, unknown>>>(
      `/repos/${repository}/rulesets?includes_parents=true&per_page=100`)
    if (summaries.length >= 100) throw new Error("github_rulesets_unbounded")
    for (const summary of summaries) {
      if (summary.enforcement !== "active") continue
      const id = Number(summary.id)
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("github_ruleset_malformed")
      const ruleset = await this.request<Record<string, unknown>>(
        `/repos/${repository}/rulesets/${id}`)
      if (!Array.isArray(ruleset.bypass_actors)) throw new Error("github_ruleset_malformed")
      if (ruleset.bypass_actors.length > 0) return true
    }
    return false
  }

  private async loadReviewThreads(repository: string, pullRequestNumber: number): Promise<number> {
    const [owner, name] = repository.split("/")
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}pageInfo{hasNextPage}}}}}`
    const result = await this.request<Record<string, unknown>>("/graphql", { method: "POST",
      body: JSON.stringify({ query, variables: { owner, name,
        number: pullRequestNumber } }) })
    const repositoryNode = object(object(result.data).repository)
    const pullRequest = object(repositoryNode.pullRequest)
    const threads = object(pullRequest.reviewThreads)
    const nodes = Array.isArray(threads.nodes) ? threads.nodes as Array<Record<string, unknown>> : []
    if (object(threads.pageInfo).hasNextPage === true) throw new Error("review_threads_unbounded")
    return nodes.filter((node) => node.isResolved !== true).length
  }

  publishReviewCheck(repository: string, headSha: string,
    accepted: boolean, description: string): Promise<unknown> {
    return this.request(`/repos/${repository}/check-runs`, {
      method: "POST", body: JSON.stringify({ name: REVIEW_CHECK_NAME, head_sha: headSha,
        status: "completed", conclusion: accepted ? "success" : "failure",
        output: { title: REVIEW_CHECK_NAME, summary: description.slice(0, 65_000) } }) })
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, { ...init,
      headers: { Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`github_review_request_failed:${response.status}`)
    return await response.json() as T
  }
}

export function parseChangedHunks(path: string, patch: string): ReviewChangedHunk[] {
  const hunks: ReviewChangedHunk[] = []
  let current: ReviewChangedHunk | null = null
  let oldLine = 0
  const finish = () => { if (current) hunks.push(current); current = null }
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      finish()
      const oldStart = Number(header[1]); const oldCount = Number(header[2] ?? 1)
      const newStart = Number(header[3]); const newCount = Number(header[4] ?? 1)
      oldLine = oldStart
      current = { path, old_start: oldStart,
        old_end: oldStart + Math.max(oldCount, 1) - 1, new_start: newStart,
        new_end: newStart + Math.max(newCount, 1) - 1,
        changed_line_count: 0, changed_line_anchors: [] }
      continue
    }
    if (!current || line.startsWith("\\ No newline at end of file")) continue
    if (line.startsWith("-")) {
      current.changed_line_count += 1; current.changed_line_anchors.push(oldLine); oldLine += 1
    } else if (line.startsWith("+")) {
      current.changed_line_count += 1; current.changed_line_anchors.push(oldLine)
    } else {
      oldLine += 1
    }
  }
  finish()
  return hunks
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
function text(value: unknown): string { return typeof value === "string" ? value : "" }
function conclusion(values: Array<Record<string, unknown>>): "success" | "pending" | "failure" | "unknown" {
  if (values.length === 0) return "unknown"
  const value = latestEvidence(values)
  const states = [String(value.conclusion ?? value.state ?? value.status)]
  if (states.some((state) => ["failure", "failed", "error", "cancelled", "timed_out"].includes(state))) {
    return "failure"
  }
  if (states.some((state) => ["queued", "pending", "in_progress"].includes(state))) return "pending"
  return states.every((state) => ["success", "completed", "neutral", "skipped"].includes(state))
    ? "success" : "unknown"
}

function latestEvidence(values: Array<Record<string, unknown>>): Record<string, unknown> {
  let latest = values[0]
  let latestScore = evidenceScore(latest, 0)
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index]
    const score = evidenceScore(value, index)
    if (score >= latestScore) { latest = value; latestScore = score }
  }
  return latest
}

function evidenceScore(value: Record<string, unknown>, index: number): number {
  for (const key of ["completed_at", "updated_at", "created_at", "started_at"]) {
    const parsed = Date.parse(text(value[key]))
    if (!Number.isNaN(parsed)) return parsed
  }
  const id = Number(value.id)
  return Number.isFinite(id) ? id : index
}

function hasBypassActors(allowances: Record<string, unknown>): boolean {
  return ["users", "teams", "apps"].some((key) =>
    Array.isArray(allowances[key]) && allowances[key].length > 0)
}

function requiredConclusion(bareContexts: string[],
  boundChecks: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>>,
  statuses: Array<Record<string, unknown>>): "success" | "pending" | "failure" | "unknown" {
  if (bareContexts.length === 0 && boundChecks.length === 0) return "unknown"
  const results = [
    ...bareContexts.map((name) => conclusion([
      ...runs.filter((run) => run.name === name),
      ...statuses.filter((status) => status.context === name),
    ])),
    ...boundChecks.map((required) => conclusion(runs.filter((run) =>
      run.name === required.context && Number(object(run.app).id) === Number(required.app_id)))),
  ]
  if (results.some((result) => result === "failure")) return "failure"
  if (results.some((result) => result === "pending")) return "pending"
  return results.every((result) => result === "success") ? "success" : "unknown"
}
