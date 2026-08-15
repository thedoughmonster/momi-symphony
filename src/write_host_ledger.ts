import { randomUUID } from "node:crypto"
import { chmod, rename, writeFile } from "node:fs/promises"

import type { HostCancellationRecord, HostRecord } from "./types.ts"

export async function writeHostLedger(
  path: string,
  records: HostRecord[],
  cancellations: HostCancellationRecord[],
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ records, cancellations }, null, 2),
    { encoding: "utf8", mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
