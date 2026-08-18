import type { ServerResponse } from "node:http"

export function writeNodeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(body))
}
