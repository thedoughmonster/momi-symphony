import { REVIEW_CHECK_NAME } from "../../../src/independent_review.ts"

export type GitHubReviewSubject = {
  repository: string
  pullRequestNumber: number
  state: "open" | "closed"
  baseBranch: string
  headSha: string
  baseSha: string
  changedPaths: string[]
  diffArtifactRef: string
}

export type GitHubMergeFacts = {
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
  constructor(fetchImpl: typeof fetch = fetch, token = Deno.env.get("MOMI_GITHUB_REVIEW_TOKEN")?.trim() ?? "") {
    if (!token) throw new Error("github_review_credential_unconfigured")
    this.token = token; this.fetchImpl = fetchImpl
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
    return { repository, pullRequestNumber, state: pr.state as "open" | "closed",
      baseBranch, headSha, baseSha, changedPaths,
      diffArtifactRef: `https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}` }
  }

  async loadMergeFacts(repository: string, baseBranch: string,
    pullRequestNumber: number, headSha: string): Promise<GitHubMergeFacts> {
    const [checks, statuses, protection, reviews, threads] = await Promise.all([
      this.request<Record<string, unknown>>(`/repos/${repository}/commits/${headSha}/check-runs`),
      this.request<Array<Record<string, unknown>>>(`/repos/${repository}/commits/${headSha}/statuses`),
      this.request<Record<string, unknown>>(
        `/repos/${repository}/branches/${encodeURIComponent(baseBranch)}/protection`),
      this.request<Array<Record<string, unknown>>>(`/repos/${repository}/pulls/${pullRequestNumber}/reviews`),
      this.loadReviewThreads(repository, pullRequestNumber).catch(() => null),
    ])
    const runs = Array.isArray(checks.check_runs) ? checks.check_runs as Array<Record<string, unknown>> : []
    const reviewStatuses = statuses.filter((status) => status.context === REVIEW_CHECK_NAME)
    const reviewCheck = conclusion([...runs.filter((run) => run.name === REVIEW_CHECK_NAME),
      ...reviewStatuses])
    const required = object(protection.required_status_checks)
    const requiredNames = [
      ...(Array.isArray(required.contexts) ? required.contexts : []),
      ...(Array.isArray(required.checks) ? (required.checks as Array<Record<string, unknown>>)
        .map((check) => check.context) : []),
    ]
    const ciRuns = runs.filter((run) => run.name !== REVIEW_CHECK_NAME &&
      requiredNames.includes(run.name))
    const ciStatuses = statuses.filter((status) => status.context !== REVIEW_CHECK_NAME &&
      requiredNames.includes(status.context))
    const enforceAdmins = object(protection.enforce_admins)
    const latestReviewByAuthor = new Map<string, string>()
    for (const review of reviews.sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))) {
      const login = text(object(review.user).login)
      if (login) latestReviewByAuthor.set(login, String(review.state ?? "").toUpperCase())
    }
    return { requiredCi: { headSha, conclusion: conclusion([...ciRuns, ...ciStatuses]) },
      reviewCheck: { name: REVIEW_CHECK_NAME, headSha, conclusion: reviewCheck },
      reviewCheckRequired: requiredNames.includes(REVIEW_CHECK_NAME),
      bypassPossible: protection.allow_force_pushes === true ||
        protection.allow_deletions === true || enforceAdmins.enabled !== true,
      authoritativeBlockingThreads: threads === null ? -1 : threads,
      authoritativeChangesRequested: [...latestReviewByAuthor.values()]
        .some((state) => state === "CHANGES_REQUESTED") }
  }

  async compareChangedPaths(repository: string, previousSha: string,
    nextSha: string): Promise<string[]> {
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
    return paths
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
    return this.request(`/repos/${repository}/statuses/${headSha}`, {
      method: "POST", body: JSON.stringify({ state: accepted ? "success" : "failure",
        context: REVIEW_CHECK_NAME, description: description.slice(0, 140) }) })
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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}
function text(value: unknown): string { return typeof value === "string" ? value : "" }
function conclusion(values: Array<Record<string, unknown>>): "success" | "pending" | "failure" | "unknown" {
  if (values.length === 0) return "unknown"
  const states = values.map((value) => String(value.conclusion ?? value.state ?? value.status))
  if (states.some((state) => ["failure", "failed", "error", "cancelled", "timed_out"].includes(state))) {
    return "failure"
  }
  if (states.some((state) => ["queued", "pending", "in_progress"].includes(state))) return "pending"
  return states.every((state) => ["success", "completed", "neutral", "skipped"].includes(state))
    ? "success" : "unknown"
}
