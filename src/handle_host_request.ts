import type { IncomingMessage, ServerResponse } from "node:http"

import { isBearerAuthorized } from "./is_bearer_authorized.ts"
import type { HostController } from "./host_controller.ts"
import { parseHostDispatch } from "./parse_host_dispatch.ts"
import { parseHostCancellation } from "./parse_host_cancellation.ts"
import { readNodeBody } from "./read_node_body.ts"
import { writeNodeJson } from "./write_node_json.ts"

export async function handleHostRequest(
  request: IncomingMessage,
  response: ServerResponse,
  controller: HostController,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://agent-control.local").pathname
  if (request.method === "GET" && path === "/health") {
    writeNodeJson(response, 200, { ok: true, service: "momi-agent-control-host" }); return
  }
  if (request.method !== "POST" || !["/v1/dispatch", "/v1/cancel"].includes(path)) {
    writeNodeJson(response, 404, { ok: false }); return
  }
  const secret = process.env.MOMI_CODEX_HOST_SECRET?.trim() ?? ""
  if (!await isBearerAuthorized(String(request.headers.authorization ?? ""), secret)) {
    writeNodeJson(response, 401, { ok: false }); return
  }
  try {
    const body = await readNodeBody(request)
    if (path === "/v1/cancel") {
      const input = parseHostCancellation(body)
      if (!input) { writeNodeJson(response, 400, { ok: false }); return }
      const result = await controller.cancel(input)
      writeNodeJson(response, 200, { ok: true, ...result }); return
    }
    const input = parseHostDispatch(body)
    if (!input) { writeNodeJson(response, 400, { ok: false }); return }
    const accepted = await controller.dispatch(input)
    writeNodeJson(response, 200, { ok: true, disposition: "accepted", ...accepted })
  } catch (error) {
    const code = error instanceof Error ? error.message : "host_dispatch_failed"
    const status = code === "host_dispatch_in_progress" ? 409
      : code.includes("refused") || code.includes("conflict") ? 400 : 503
    writeNodeJson(response, status, { ok: false, disposition: "refused" })
  }
}
