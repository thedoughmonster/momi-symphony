import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { prepareReviewWorkspace } from "../src/prepare_review_workspace.ts"
import { cleanupReviewWorkspace } from "../src/cleanup_review_workspace.ts"
import { HostController } from "../src/host_controller.ts"
import { HostLedger } from "../src/host_ledger.ts"
import { ReviewCredentialBoundary } from "../src/review_credential_boundary.ts"
import type { AppServerClient, HostDispatch } from "../src/types.ts"

const run = promisify(execFile)

test("review workspace is a detached exact-head snapshot reused only after a clean checkout", async () => {
  const repository = await mkdtemp(join(tmpdir(), "momi-review-source-"))
  const reviewWorkspaceRoot = await mkdtemp(join(tmpdir(), "momi-review-workspaces-"))
  const implementationId = randomUUID()
  let workspace = ""
  try {
    await run("git", ["init", "-b", "main"], { cwd: repository })
    await run("git", ["config", "user.name", "Review Test"], { cwd: repository })
    await run("git", ["config", "user.email", "review@example.invalid"], { cwd: repository })
    await writeFile(join(repository, "subject.txt"), "first\n")
    await run("git", ["add", "subject.txt"], { cwd: repository })
    await run("git", ["commit", "-m", "first"], { cwd: repository })
    const first = (await run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
    const dispatch = { schema_version: 4, work_id: randomUUID(),
      review_workspace_id: randomUUID(), review_subject: {
      implementation_dispatch_id: implementationId, head_sha: first,
    } } as HostDispatch
    workspace = await prepareReviewWorkspace({ workspaceRoot: repository,
      repository: "thedoughmonster/momi-symphony", baseBranch: "main",
      reviewRepositoryRoot: repository, reviewWorkspaceRoot }, dispatch)
    assert.equal(await readFile(join(workspace, "subject.txt"), "utf8"), "first\n")

    await writeFile(join(repository, "subject.txt"), "second\n")
    await run("git", ["add", "subject.txt"], { cwd: repository })
    await run("git", ["commit", "-m", "second"], { cwd: repository })
    const second = (await run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
    const updated = { ...dispatch, work_id: randomUUID(),
      review_subject: { ...dispatch.review_subject!, head_sha: second, generation: 2 } }
    const nextWorkspace = await prepareReviewWorkspace({ workspaceRoot: repository,
      repository: "thedoughmonster/momi-symphony", baseBranch: "main",
      reviewRepositoryRoot: repository, reviewWorkspaceRoot }, updated)
    assert.equal(nextWorkspace, workspace)
    assert.equal(await readFile(join(nextWorkspace, "subject.txt"), "utf8"), "second\n")
    await cleanupReviewWorkspace({ workspaceRoot: repository,
      repository: "thedoughmonster/momi-symphony", baseBranch: "main",
      reviewRepositoryRoot: repository, reviewWorkspaceRoot }, {
      runtimeRole: "independent_reviewer", reviewWorkspaceId: dispatch.review_workspace_id,
    })
    assert.equal(await stat(nextWorkspace).then(() => true, () => false), false)
  } finally {
    if (workspace) await run("git", ["worktree", "remove", "--force", workspace],
      { cwd: repository }).catch(() => undefined)
    await rm(repository, { recursive: true, force: true })
    await rm(reviewWorkspaceRoot, { recursive: true, force: true })
  }
})

test("terminal implementation cleanup removes an abandoned changes-requested workspace", async () => {
  const repository = await mkdtemp(join(tmpdir(), "momi-review-cleanup-source-"))
  const ledgerDirectory = await mkdtemp(join(tmpdir(), "momi-review-cleanup-ledger-"))
  const reviewWorkspaceRoot = await mkdtemp(join(tmpdir(), "momi-review-workspaces-"))
  const implementationId = randomUUID(); const reviewerId = randomUUID()
  let workspace = ""
  try {
    await run("git", ["init", "-b", "main"], { cwd: repository })
    await run("git", ["config", "user.name", "Review Test"], { cwd: repository })
    await run("git", ["config", "user.email", "review@example.invalid"], { cwd: repository })
    await writeFile(join(repository, "subject.txt"), "subject\n")
    await run("git", ["add", "subject.txt"], { cwd: repository })
    await run("git", ["commit", "-m", "subject"], { cwd: repository })
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
    const subject = { implementation_dispatch_id: implementationId, pull_request_number: 16,
      head_sha: head, base_sha: head, generation: 1, profile: "high" as const,
      model: "gpt-5.6-sol" as const, reasoning_effort: "high" as const,
      budget_fingerprint: "fnv1a64:0b9ef0157af3f30a",
      policy_version: "independent-review-v1" }
    const reviewDispatch = { schema_version: 4, work_id: reviewerId,
      review_workspace_id: reviewerId, review_subject: subject } as HostDispatch
    const config = { workspaceRoot: repository, repository: "thedoughmonster/momi-symphony",
      baseBranch: "main", reviewRepositoryRoot: repository, reviewWorkspaceRoot }
    workspace = await prepareReviewWorkspace(config, reviewDispatch)
    const ledger = new HostLedger(join(ledgerDirectory, "ledger.json"),
      new ReviewCredentialBoundary(Buffer.alloc(32, 7)))
    await ledger.reserve(reviewerId, "review-fingerprint", randomUUID(), "one_shot", {
      runtime_role: "independent_reviewer", review_subject: subject,
      review_workspace_id: reviewerId })
    await ledger.accept(reviewerId, "review-thread", "review-turn")
    await ledger.terminal(reviewerId, { readiness_result: "ready",
      terminal_disposition: "completed", summary: "Changes requested." },
    new Date().toISOString(), { result: "changes_requested", findings: [],
      artifact_ref: "review://attempt/1", result_fingerprint: `sha256:${"1".repeat(64)}` })
    await ledger.callbackSent(reviewerId)
    await ledger.reserve(implementationId, "implementation-fingerprint", randomUUID())
    await ledger.accept(implementationId, "implementation-thread", "implementation-turn")
    await ledger.terminal(implementationId, { readiness_result: "ready",
      terminal_disposition: "completed", summary: "Implementation completed." },
    new Date().toISOString())
    const client = { connect: () => Promise.resolve(), onNotification: () => undefined,
      request: () => Promise.resolve({}) } as AppServerClient
    await new HostController(client, ledger, config, () => Promise.resolve()).start()
    assert.equal(await stat(workspace).then(() => true, () => false), false)
    assert.notEqual(ledger.get(reviewerId)?.reviewWorkspaceCleanedAt, null)
  } finally {
    if (workspace) await run("git", ["worktree", "remove", "--force", workspace],
      { cwd: repository }).catch(() => undefined)
    await rm(repository, { recursive: true, force: true })
    await rm(ledgerDirectory, { recursive: true, force: true })
    await rm(reviewWorkspaceRoot, { recursive: true, force: true })
  }
})
