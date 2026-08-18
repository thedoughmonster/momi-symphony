import { randomUUID } from "node:crypto"
import { chmod, rename, writeFile } from "node:fs/promises"

import type { HostCancellationRecord, HostRecord, HostRecoveryRecord } from "./types.ts"

export async function writeHostLedger(
  path: string,
  records: HostRecord[],
  cancellations: HostCancellationRecord[],
  recoveries: HostRecoveryRecord[],
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ records, cancellations, recoveries }, null, 2),
    { encoding: "utf8", mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
