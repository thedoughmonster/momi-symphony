import assert from "node:assert/strict"

import type { Sql } from "postgres"

const signature = "momi_agent_ops.recover_dead_letter_dispatch_v1(uuid,text,integer,text,text,text)"

export async function assertRecoverySecurity(sql: Sql): Promise<void> {
  const rows = await sql<{ role_name: string; can_execute: boolean }[]>`
    select role_name,
      has_function_privilege(role_name, ${signature}, 'EXECUTE') as can_execute
    from (values ('anon'), ('authenticated'), ('service_role')) roles(role_name)
  `
  assert.deepEqual(rows.map((row) => [row.role_name, row.can_execute]), [
    ["anon", false],
    ["authenticated", false],
    ["service_role", false],
  ])
  const [owner] = await sql<{ can_execute: boolean }[]>`
    select has_function_privilege(current_user, ${signature}, 'EXECUTE') as can_execute`
  assert.equal(owner.can_execute, true)
}
