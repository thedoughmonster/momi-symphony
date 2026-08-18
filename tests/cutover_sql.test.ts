import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const projectId = "de0dbcdb-9025-4ccc-8b3c-56f23d7367d5"
const repository = "thedoughmonster/momi-symphony"

test("the development mapping cutover is singular, HTTPS-only, and reversible", async () => {
  const migration = await readFile(
    "supabase/migrations/20260818152105_configure_symphony_control_plane_mapping.sql",
    "utf8",
  )
  const rollback = await readFile("ops/sql/disable_symphony_control_plane_mapping.sql", "utf8")
  const restore = await readFile("ops/sql/enable_symphony_control_plane_mapping.sql", "utf8")

  assert.match(migration, /into strict source_active_states, source_host_dispatch_url/)
  assert.match(migration, /where mapping\.linear_project_name = 'Backend Stabilization'\s+and mapping\.active/)
  assert.match(migration, /source_host_dispatch_url !~ '\^https:\/\/'/)
  assert.match(migration, new RegExp(projectId))
  assert.match(migration, new RegExp(repository.replace("/", "\\/")))
  assert.match(migration, /'main'/)
  assert.match(migration, /on conflict \(linear_project_id\) do update/)

  assert.match(rollback, new RegExp(projectId))
  assert.match(rollback, new RegExp(repository.replace("/", "\\/")))
  assert.match(rollback, /and base_branch = 'main'/)
  assert.match(rollback, /and host_dispatch_url ~ '\^https:\/\/'/)
  assert.match(rollback, /set active = false/)
  assert.match(rollback, /get diagnostics updated_count = row_count/)
  assert.match(rollback, /updated_count <> 1/)
  assert.doesNotMatch(rollback, /delete\s+from/i)

  assert.match(restore, new RegExp(projectId))
  assert.match(restore, new RegExp(repository.replace("/", "\\/")))
  assert.match(restore, /and base_branch = 'main'/)
  assert.match(restore, /and host_dispatch_url ~ '\^https:\/\/'/)
  assert.match(restore, /set active = true/)
  assert.match(restore, /get diagnostics updated_count = row_count/)
  assert.match(restore, /updated_count <> 1/)
  assert.doesNotMatch(restore, /delete\s+from/i)
})
