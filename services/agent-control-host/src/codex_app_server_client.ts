import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import WebSocket from "ws"

import type { AppServerClient } from "./types.ts"

export class CodexAppServerClient implements AppServerClient {
  private socket: WebSocket | null = null
  private sequence = 0
  private pending = new Map<number, { resolve: (value: unknown) => void;
    reject: (error: Error) => void; timeout: NodeJS.Timeout }>()
  private listener: (notification: Record<string, unknown>) => void = () => undefined

  async connect(): Promise<void> {
    if (this.socket) return
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
    if (!isAbsolute(codexHome)) throw new Error("codex_proxy_path_invalid")
    const path = join(codexHome, "app-server-control", "app-server-control.sock")
    const socket = new WebSocket(`ws+unix://${path}:/`, { perMessageDeflate: false })
    this.socket = socket; socket.on("message", (data) => this.consume(data.toString()))
    socket.on("error", () => undefined)
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout); pending.reject(new Error("codex_proxy_exited"))
      }
      this.pending.clear(); this.socket = null
    })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve); socket.once("error", reject)
    })
    await this.request("initialize", { clientInfo: {
      name: "momi-agent-control", title: "MoMi Agent Control", version: "1.0.0",
    }, capabilities: { experimentalApi: true, requestAttestation: false } })
    this.write({ method: "initialized" })
  }

  onNotification(listener: (notification: Record<string, unknown>) => void): void {
    this.listener = listener
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("codex_proxy_not_connected"))
    }
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id); reject(new Error("codex_app_server_timeout"))
      }, 15_000)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout })
      this.write({ id, method, params })
    })
  }

  private consume(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timeout); this.pending.delete(message.id)
      if (message.error) pending.reject(new Error("codex_app_server_error"))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.method === "string") this.listener(message)
  }

  private write(message: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("codex_proxy_write_failed")
    this.socket.send(JSON.stringify(message))
  }
}
