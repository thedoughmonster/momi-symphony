import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { HostCancellationRecord, HostRecord, HostRecoveryRecord } from "./types.ts"

export async function readHostLedger(path: string): Promise<{
  records?: HostRecord[]; cancellations?: HostCancellationRecord[]
  recoveries?: HostRecoveryRecord[]
}> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return {}
  }
}
