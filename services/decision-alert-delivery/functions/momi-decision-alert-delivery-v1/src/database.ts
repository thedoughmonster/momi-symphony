import postgres from "postgres"

let database: ReturnType<typeof postgres> | null = null

export function getDatabase(): ReturnType<typeof postgres> {
  if (database) return database
  const url = Deno.env.get("SUPABASE_DB_URL")?.trim()
  if (!url) throw new Error("decision_database_unavailable")
  database = postgres(url, { prepare: false, max: 1 })
  return database
}
