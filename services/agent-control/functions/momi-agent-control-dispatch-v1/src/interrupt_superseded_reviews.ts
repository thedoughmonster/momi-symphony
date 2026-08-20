import type { Sql } from "postgres"

import { getDatabase } from "../../../src/database.ts"
import type { LifecycleEvidenceInput } from "./types.ts"

type ReviewInterruption = { reviewer_dispatch_id: string; host_dispatch_url: string }

/** Durably interrupt reviewer turns made non-authoritative by a newer validated head. */
export async function interruptSupersededReviews(
  input: LifecycleEvidenceInput,
  sql: Sql = getDatabase(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (input.phase !== "validating") return
  const targets = await sql<ReviewInterruption[]>`
    select review.reviewer_dispatch_id::text, mapping.host_dispatch_url
    from momi_agent_ops.review_attempts review
    join momi_agent_ops.dispatches work
      on work.dispatch_id = review.implementation_dispatch_id
    join momi_agent_ops.project_mappings mapping
      on mapping.linear_project_id = work.linear_project_id and mapping.active
      and mapping.repository = work.mapped_repository
      and mapping.base_branch = work.mapped_base_branch
    where review.implementation_dispatch_id = ${input.work_id}::uuid
      and review.state = 'superseded'
      and review.reviewer_thread_id is not null and review.reviewer_turn_id is not null
      and review.interruption_confirmed_at is null
    order by review.reviewer_dispatch_id`
  if (!targets.length) return
  const secret = Deno.env.get("MOMI_CODEX_HOST_SECRET")?.trim() ?? ""
  if (!secret) throw new Error("review_host_secret_unconfigured")
  for (const target of targets) {
    const url = new URL(target.host_dispatch_url)
    const loopback = new Set(["localhost", "127.0.0.1", "::1"]).has(url.hostname)
    if ((!loopback && url.protocol !== "https:") ||
      !url.pathname.endsWith("/v1/dispatch")) throw new Error("review_host_route_refused")
    url.pathname = `${url.pathname.slice(0, -"/v1/dispatch".length)}/v1/cancel`
    const response = await fetchImpl(url, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ schema_version: 2, work_id: target.reviewer_dispatch_id,
        capability_token: input.capability_token,
        target_work_ids: [target.reviewer_dispatch_id], repository: input.repository,
        base_branch: input.base_branch }), signal: AbortSignal.timeout(10_000) })
    const result = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok || !["requested", "already_terminal"].includes(
      String(result?.cancellation_state))) throw new Error("reviewer_interruption_failed")
  }
}
