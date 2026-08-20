import { createHash } from "node:crypto"
import type { HostCancellation } from "./types.ts"

export function cancellationFingerprint(input: HostCancellation): string {
  return createHash("sha256").update(JSON.stringify({ base_branch: input.base_branch,
    repository: input.repository, schema_version: input.schema_version,
    target_work_ids: input.target_work_ids, work_id: input.work_id })).digest("hex")
}
