import { execFile } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import type { HostConfiguration, HostDispatch } from "./types.ts"

const run = promisify(execFile)

/** Materialize a host-owned, detached exact-head worktree for read-only review turns. */
export async function prepareReviewWorkspace(
  config: HostConfiguration,
  input: HostDispatch,
): Promise<string> {
  if (input.schema_version !== 4 || !input.review_subject || !input.review_workspace_id) {
    throw new Error("review_workspace_subject_missing")
  }
  const root = config.reviewWorkspaceRoot
  const repository = config.reviewRepositoryRoot
  if (!root || !repository) throw new Error("review_workspace_boundary_missing")
  const workspace = join(root, input.review_workspace_id)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const revision = input.review_subject.head_sha
  const revisionExists = await run("git", ["-C", repository, "cat-file", "-e",
    `${revision}^{commit}`]).then(() => true, () => false)
  if (!revisionExists) {
    const pullRequestRef = `+refs/pull/${input.review_subject.pull_request_number}/head:` +
      `refs/momi-review/${input.review_workspace_id}`
    await run("git", ["-C", repository, "fetch", "--no-tags", "--force",
      `https://github.com/${config.repository}.git`, pullRequestRef])
  }
  const available = await run("git", ["-C", repository, "rev-parse", `${revision}^{commit}`])
  if (available.stdout.trim() !== revision) throw new Error("review_workspace_revision_missing")
  const exists = await stat(workspace).then(() => true, () => false)
  if (!exists) {
    await run("git", ["-C", repository, "worktree", "add", "--detach", workspace, revision])
  } else {
    const dirty = await run("git", ["-C", workspace, "status", "--porcelain"])
    if (dirty.stdout.trim()) throw new Error("review_workspace_dirty")
    await run("git", ["-C", workspace, "checkout", "--detach",
      revision])
  }
  const exact = await run("git", ["-C", workspace, "rev-parse", "HEAD"])
  if (exact.stdout.trim() !== revision) {
    throw new Error("review_workspace_revision_mismatch")
  }
  return workspace
}
