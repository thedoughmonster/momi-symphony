import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import type { HostConfiguration, HostRecord } from "./types.ts"

const run = promisify(execFile)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Remove only the exact host-owned review worktree recorded for this review lineage. */
export async function cleanupReviewWorkspace(
  config: HostConfiguration,
  record: Pick<HostRecord, "reviewWorkspaceId" | "runtimeRole">,
): Promise<void> {
  if (record.runtimeRole !== "independent_reviewer" || !record.reviewWorkspaceId) return
  if (!uuid.test(record.reviewWorkspaceId)) throw new Error("review_workspace_identity_invalid")
  if (!config.reviewWorkspaceRoot || !config.reviewRepositoryRoot) {
    throw new Error("review_workspace_boundary_missing")
  }
  const workspace = join(config.reviewWorkspaceRoot, record.reviewWorkspaceId)
  if (!await stat(workspace).then(() => true, () => false)) return
  await run("git", ["-C", config.reviewRepositoryRoot,
    "worktree", "remove", "--force", workspace])
}
