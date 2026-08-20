import assert from "node:assert/strict"

import type { Sql } from "postgres"

import { ownerOne, routeKey } from "./contract.ts"

const roles = ["anon", "authenticated", "service_role"] as const

export async function assertSchedulerSecurity(sql: Sql): Promise<void> {
  const tables = await sql<{
    relname: string
    relrowsecurity: boolean
    anon_access: boolean
    authenticated_access: boolean
    service_access: boolean
  }[]>`
    select class.relname, class.relrowsecurity,
      has_table_privilege('anon', class.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_access,
      has_table_privilege('authenticated', class.oid,
        'SELECT,INSERT,UPDATE,DELETE') as authenticated_access,
      has_table_privilege('service_role', class.oid,
        'SELECT,INSERT,UPDATE,DELETE') as service_access
    from pg_class class
    join pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'momi_agent_ops'
      and class.relname in ('scheduler_route_policies', 'scheduler_leaders',
        'scheduler_candidates', 'scheduler_slots')
    order by class.relname
  `
  assert.equal(tables.length, 4)
  for (const table of tables) assert.deepEqual(
    [table.relrowsecurity, table.anon_access, table.authenticated_access,
      table.service_access],
    [true, false, false, false],
  )

  const functions = await sql<{
    proname: string
    prosecdef: boolean
    proconfig: string[] | null
    anon_execute: boolean
    authenticated_execute: boolean
    service_execute: boolean
  }[]>`
    select procedure.proname, procedure.prosecdef, procedure.proconfig,
      has_function_privilege('anon', procedure.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', procedure.oid, 'EXECUTE') as authenticated_execute,
      has_function_privilege('service_role', procedure.oid, 'EXECUTE') as service_execute
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'momi_agent_ops'
      and procedure.proname like '%scheduler%'
    order by procedure.proname
  `
  assert.equal(functions.length, 9)
  for (const routine of functions) {
    assert.equal(routine.prosecdef, false, routine.proname)
    assert.deepEqual(routine.proconfig, ["search_path=\"\""], routine.proname)
    assert.deepEqual([routine.anon_execute, routine.authenticated_execute,
      routine.service_execute], [false, false, false], routine.proname)
  }

  for (const role of roles) {
    await assert.rejects(sql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${role}`)
      await transaction.unsafe(`select * from momi_agent_ops.claim_scheduler_candidate_v1(
        '${routeKey}', '${ownerOne}', '${"b".repeat(40)}', 1,
        '20000000-0000-4000-8000-000000000001', 1, 1
      )`)
    }), /permission denied/)
  }
}
