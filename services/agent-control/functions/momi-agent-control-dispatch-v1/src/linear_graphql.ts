import { readLinearAccessToken } from "./read_linear_access_token.ts"

export const LINEAR_GRAPHQL_TIMEOUT_MS = 30_000

export type LinearGraphqlErrorCode =
  | "invalid_tracker_config"
  | "tracker_timeout"
  | "tracker_request"
  | "tracker_http_auth"
  | "tracker_http_forbidden"
  | "tracker_http_rate_limit"
  | "tracker_http_server"
  | "tracker_http_other"
  | "tracker_graphql"
  | "tracker_payload"

export class LinearGraphqlError extends Error {
  readonly code: LinearGraphqlErrorCode
  constructor(code: LinearGraphqlErrorCode) {
    super(code)
    this.name = "LinearGraphqlError"
    this.code = code
  }
}

export async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const token = readLinearAccessToken()
  if (!token) throw new LinearGraphqlError("invalid_tracker_config")
  let response: Response
  try {
    response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(LINEAR_GRAPHQL_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    throw new LinearGraphqlError(
      name === "TimeoutError" || name === "AbortError"
        ? "tracker_timeout"
        : "tracker_request",
    )
  }
  if (!response.ok) throw new LinearGraphqlError(httpErrorCode(response.status))
  const body = await response.json().catch(() => null) as {
    data?: T; errors?: unknown
  } | null
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LinearGraphqlError("tracker_payload")
  }
  if (body.errors !== undefined) {
    if (!Array.isArray(body.errors)) throw new LinearGraphqlError("tracker_payload")
    if (body.errors.length > 0) throw new LinearGraphqlError("tracker_graphql")
  }
  if (!("data" in body) || body.data === null || body.data === undefined) {
    throw new LinearGraphqlError("tracker_payload")
  }
  return body.data
}

function httpErrorCode(status: number): LinearGraphqlErrorCode {
  if (status === 401) return "tracker_http_auth"
  if (status === 403) return "tracker_http_forbidden"
  if (status === 429) return "tracker_http_rate_limit"
  if (status >= 500 && status <= 599) return "tracker_http_server"
  return "tracker_http_other"
}
