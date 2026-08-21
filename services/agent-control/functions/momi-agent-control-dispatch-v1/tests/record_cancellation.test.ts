import assert from "node:assert/strict"
import test from "node:test"

import { recordCancellation } from "../src/record_cancellation.ts"

test("records only the host cleanup disposition after the database fence", async () => {
  const queries: string[] = []
  const sql = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    queries.push(strings.join("?")); return [{ recorded: true }]
  }
  assert.equal(await recordCancellation({
    work_id: "00000000-0000-4000-8000-000000000001",
    capability_token: "00000000-0000-4000-8000-000000000002",
  }, { cancellation_state: "requested" }, sql as never), true)
  assert.equal(queries.length, 1)
  assert.match(queries[0]!, /record_cancellation_v3/)
})
