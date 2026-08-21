import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { WebSocketServer } from "ws"

import { CodexAppServerClient } from "../src/codex_app_server_client.ts"

test("connects only to its configured App Server identity socket", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "momi-codex-daemon-"))
  const socketDirectory = join(codexHome, "app-server-control")
  const socketPath = join(socketDirectory, "app-server-control.sock")
  const server = createServer(); const webSocketServer = new WebSocketServer({ server })
  const methods: string[] = []
  try {
    await mkdir(socketDirectory)
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(socketPath, resolve)
    })
    webSocketServer.on("connection", (socket, request) => {
      assert.equal(request.headers["sec-websocket-extensions"], undefined)
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: number; method: string }
        methods.push(message.method)
        if (message.id) socket.send(JSON.stringify({ id: message.id,
          result: message.method === "thread/read"
            ? { thread: { id: "thread-managed" } } : {} }))
      })
    })
    const client = new CodexAppServerClient(codexHome); await client.connect()
    const result = await client.request<{ thread: { id: string } }>(
      "thread/read", { threadId: "thread-managed" })
    assert.equal(result.thread.id, "thread-managed")
    assert.deepEqual(methods, ["initialize", "initialized", "thread/read"])
  } finally {
    for (const socket of webSocketServer.clients) socket.terminate()
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()))
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(codexHome, { recursive: true, force: true })
  }
})
