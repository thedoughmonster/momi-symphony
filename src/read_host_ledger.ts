import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { HostCancellationRecord, HostRecord } from "./types.ts"

export async function readHostLedger(path: string): Promise<{
  records?: HostRecord[]; cancellations?: HostCancellationRecord[]
}> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return {}
  }
}
