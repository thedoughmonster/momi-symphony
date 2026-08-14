import { createServer, type Server } from "node:http"
import { isAbsolute } from "node:path"

import { CodexAppServerClient } from "./codex_app_server_client.ts"
import { handleHostRequest } from "./handle_host_request.ts"
import { HostController } from "./host_controller.ts"
import { HostLedger } from "./host_ledger.ts"

export async function startHostAdapter(): Promise<Server> {
  const workspaceRoot = process.env.MOMI_CODEX_WORKSPACE_ROOT?.trim() ?? ""
  const ledgerPath = process.env.MOMI_AGENT_CONTROL_LEDGER_PATH?.trim() ?? ""
  const repository = process.env.MOMI_CODEX_REPOSITORY?.trim() ?? ""
  const baseBranch = process.env.MOMI_CODEX_BASE_BRANCH?.trim() ?? ""
  const callback = process.env.MOMI_AGENT_CONTROL_CALLBACK_URL?.trim() ?? ""
  const secret = process.env.MOMI_CODEX_HOST_SECRET?.trim() ?? ""
  const host = process.env.MOMI_AGENT_CONTROL_HOST?.trim() || "127.0.0.1"
  const port = Number(process.env.MOMI_AGENT_CONTROL_PORT ?? "47931")
  let callbackUrl: URL | null = null
  try { callbackUrl = new URL(callback) } catch { /* validated below */ }
  const loopback = callbackUrl
    ? new Set(["localhost", "127.0.0.1", "::1"]).has(callbackUrl.hostname) : false
  if (!isAbsolute(workspaceRoot) || !isAbsolute(ledgerPath) || !repository ||
    !baseBranch || !secret || !callbackUrl || (!loopback && callbackUrl.protocol !== "https:") ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("agent_control_host_configuration_invalid")
  }
  const controller = new HostController(new CodexAppServerClient(),
    new HostLedger(ledgerPath), { workspaceRoot, repository, baseBranch })
  await controller.start()
  const server = createServer((request, response) => {
    void handleHostRequest(request, response, controller)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(port, host, resolve)
  })
  return server
}
