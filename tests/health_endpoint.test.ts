import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"

import { handleHostRequest } from "../services/agent-control-host/src/handle_host_request.ts"

test("development health contract remains unauthenticated and stable", async () => {
  const request = Object.assign(new EventEmitter(), { method: "GET", url: "/health", headers: {} })
  let status = 0
  let body = ""
  const response = {
    writeHead(code: number) { status = code },
    end(value: string) { body = value },
  }
  await handleHostRequest(request as never, response as never, {} as never)
  assert.equal(status, 200)
  assert.deepEqual(JSON.parse(body), { ok: true, service: "momi-agent-control-host" })
})
