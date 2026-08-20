import { execFile } from "node:child_process"
import { mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import type { HostConfiguration, HostDispatch } from "./types.ts"

const run = promisify(execFile)

/** Materialize a host-owned, detached exact-head worktree for read-only review turns. */
export async function prepareReviewWorkspace(
  config: HostConfiguration,
  input: HostDispatch,
): Promise<string> {
  if (input.schema_version !== 4 || !input.review_subject) {
    throw new Error("review_workspace_subject_missing")
  }
  const root = join(tmpdir(), "momi-agent-control-reviews")
  const workspace = join(root, input.work_id)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const exists = await stat(workspace).then(() => true, () => false)
  if (!exists) {
    await run("git", ["-C", config.workspaceRoot, "worktree", "add", "--detach",
      workspace, input.review_subject.head_sha])
  } else {
    const dirty = await run("git", ["-C", workspace, "status", "--porcelain"])
    if (dirty.stdout.trim()) throw new Error("review_workspace_dirty")
    await run("git", ["-C", workspace, "checkout", "--detach",
      input.review_subject.head_sha])
  }
  const exact = await run("git", ["-C", workspace, "rev-parse", "HEAD"])
  if (exact.stdout.trim() !== input.review_subject.head_sha) {
    throw new Error("review_workspace_revision_mismatch")
  }
  return workspace
}
