import postgres from "postgres"

let database: ReturnType<typeof postgres> | null = null

export function getDatabase(): ReturnType<typeof postgres> {
  if (database) return database
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL")?.trim()
  if (!databaseUrl) throw new Error("database configuration is unavailable")
  database = postgres(databaseUrl, { prepare: false, max: 1 })
  return database
}
