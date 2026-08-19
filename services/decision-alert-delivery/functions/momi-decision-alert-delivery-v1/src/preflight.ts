import { getDatabase } from "./database.ts"

export type DecisionPreflight = {
  route_mode: "disabled" | "acceptance" | "enabled"
  destination_configured: boolean
  release_configured: boolean
}

export async function readPreflight(): Promise<DecisionPreflight> {
  const sql = getDatabase()
  const rows = await sql<DecisionPreflight[]>`
    select route_mode, destination_configured, release_configured
    from momi_agent_ops.decision_alert_preflight_v1()
  `
  if (!rows[0]) throw new Error("decision_preflight_unavailable")
  return rows[0]
}
