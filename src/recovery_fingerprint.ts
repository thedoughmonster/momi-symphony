import { createHash } from "node:crypto"
import type { HostRecovery } from "./types.ts"

export function recoveryFingerprint(input: HostRecovery): string {
  return createHash("sha256").update(JSON.stringify({ schema_version: input.schema_version,
    target_work_id: input.target_work_id, work_id: input.work_id })).digest("hex")
}
