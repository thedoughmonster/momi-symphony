export async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const token = Deno.env.get("LINEAR_API_KEY")?.trim() ?? ""
  if (!token) throw new Error("linear_api_configuration_unavailable")
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8_000),
  })
  const body = await response.json().catch(() => null) as {
    data?: T; errors?: unknown[]
  } | null
  if (!response.ok || !body?.data || body.errors?.length) {
    throw new Error("linear_graphql_failed")
  }
  return body.data
}
