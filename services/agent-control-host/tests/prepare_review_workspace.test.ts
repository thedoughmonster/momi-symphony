import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { prepareReviewWorkspace } from "../src/prepare_review_workspace.ts"
import type { HostDispatch } from "../src/types.ts"

const run = promisify(execFile)

test("review workspace is a detached exact-head snapshot reused only after a clean checkout", async () => {
  const repository = await mkdtemp(join(tmpdir(), "momi-review-source-"))
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
    const dispatch = { schema_version: 4, work_id: randomUUID(), review_subject: {
      implementation_dispatch_id: implementationId, head_sha: first,
    } } as HostDispatch
    workspace = await prepareReviewWorkspace({ workspaceRoot: repository,
      repository: "thedoughmonster/momi-symphony", baseBranch: "main" }, dispatch)
    assert.equal(await readFile(join(workspace, "subject.txt"), "utf8"), "first\n")

    await writeFile(join(repository, "subject.txt"), "second\n")
    await run("git", ["add", "subject.txt"], { cwd: repository })
    await run("git", ["commit", "-m", "second"], { cwd: repository })
    const second = (await run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim()
    const updated = { ...dispatch, work_id: randomUUID(),
      review_subject: { ...dispatch.review_subject!, head_sha: second, generation: 2 } }
    const nextWorkspace = await prepareReviewWorkspace({ workspaceRoot: repository,
      repository: "thedoughmonster/momi-symphony", baseBranch: "main" }, updated)
    assert.notEqual(nextWorkspace, workspace)
    assert.equal(await readFile(join(nextWorkspace, "subject.txt"), "utf8"), "second\n")
    await run("git", ["worktree", "remove", "--force", nextWorkspace], { cwd: repository })
  } finally {
    if (workspace) await run("git", ["worktree", "remove", "--force", workspace],
      { cwd: repository }).catch(() => undefined)
    await rm(repository, { recursive: true, force: true })
  }
})
