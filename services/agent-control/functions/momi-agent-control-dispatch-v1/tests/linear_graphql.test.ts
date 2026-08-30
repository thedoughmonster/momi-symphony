import assert from "node:assert/strict"
import test from "node:test"

import {
  LINEAR_HTTP_ERROR_BODY_LIMIT_BYTES,
  LINEAR_GRAPHQL_TIMEOUT_MS,
  LinearGraphqlError,
  linearGraphql,
  type LinearGraphqlErrorCode,
} from "../src/linear_graphql.ts"

const query = "query Test { viewer { id } }"

async function withLinearToken(run: () => Promise<void>, token: string | null = "token") {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  try {
    Object.defineProperty(globalThis, "Deno", { configurable: true,
      value: { env: { get: (name: string) =>
        name === "LINEAER_ACCESS" ? token ?? undefined : undefined } } })
    await run()
  } finally {
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
}

test("classifies bounded Linear HTTP 400 rate-limit evidence", async () => {
  const fetchImpl = (() => Promise.resolve(Response.json({
    errors: [{
      message: "private provider detail",
      extensions: { code: "RATELIMITED" },
    }],
  }, { status: 400 }))) as typeof fetch
  await expectCode("tracker_http_rate_limit", fetchImpl)
})

test("keeps unrelated HTTP 400 responses fail-closed and sanitized", async () => {
  const privateMessage = "unrelated private provider detail"
  for (const body of [
    { errors: [{ message: privateMessage, extensions: { code: "BAD_USER_INPUT" } }] },
    { data: null },
  ]) {
    const fetchImpl = (() => Promise.resolve(Response.json(body, { status: 400 }))) as typeof fetch
    await expectCode("tracker_http_other", fetchImpl)
  }
})

test("rejects malformed or ambiguous HTTP 400 rate-limit evidence", async () => {
  const cases: Array<BodyInit> = [
    "not json",
    JSON.stringify({ errors: "RATELIMITED" }),
    JSON.stringify({ errors: [{ extensions: null }] }),
    JSON.stringify({ errors: [{ extensions: { code: "ratelimited" } }] }),
    JSON.stringify({ errors: [
      { extensions: { code: "RATELIMITED" } },
      { extensions: { code: "BAD_USER_INPUT" } },
    ] }),
  ]
  for (const body of cases) {
    const fetchImpl = (() => Promise.resolve(new Response(body, { status: 400 }))) as typeof fetch
    await expectCode("tracker_http_other", fetchImpl)
  }
})

test("does not inspect an oversized HTTP 400 provider body", async () => {
  const padding = "x".repeat(LINEAR_HTTP_ERROR_BODY_LIMIT_BYTES)
  const body = JSON.stringify({
    errors: [{ extensions: { code: "RATELIMITED" }, padding }],
  })
  assert.ok(new TextEncoder().encode(body).byteLength > LINEAR_HTTP_ERROR_BODY_LIMIT_BYTES)
  const fetchImpl = (() => Promise.resolve(new Response(body, { status: 400 }))) as typeof fetch
  await expectCode("tracker_http_other", fetchImpl)
})

async function expectCode(
  code: LinearGraphqlErrorCode,
  fetchImpl: typeof fetch,
  token: string | null = "token",
) {
  await withLinearToken(async () => {
    await assert.rejects(
      () => linearGraphql(query, {}, fetchImpl),
      (error: unknown) => error instanceof LinearGraphqlError &&
        error.code === code && error.message === code,
    )
  }, token)
}

test("uses the official 30 second Linear request timeout", () => {
  assert.equal(LINEAR_GRAPHQL_TIMEOUT_MS, 30_000)
})

test("classifies missing Linear configuration without making a request", async () => {
  let requested = false
  const fetchImpl = (() => {
    requested = true
    return Promise.resolve(Response.json({}))
  }) as typeof fetch
  await expectCode("invalid_tracker_config", fetchImpl, null)
  assert.equal(requested, false)
})

test("classifies aborts and timeouts without exposing the provider error", async () => {
  const providerError = new DOMException("provider detail must stay private", "TimeoutError")
  const fetchImpl = (() => Promise.reject(providerError)) as typeof fetch
  await expectCode("tracker_timeout", fetchImpl)
})

test("classifies non-timeout request failures without exposing details", async () => {
  const fetchImpl = (() => Promise.reject(new TypeError("private transport detail"))) as typeof fetch
  await expectCode("tracker_request", fetchImpl)
})

for (const [status, code] of [
  [401, "tracker_http_auth"],
  [403, "tracker_http_forbidden"],
  [429, "tracker_http_rate_limit"],
  [503, "tracker_http_server"],
  [418, "tracker_http_other"],
] as const) {
  test(`classifies HTTP ${status} as ${code}`, async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response("private response", { status }))) as typeof fetch
    await expectCode(code, fetchImpl)
  })
}

test("classifies GraphQL errors without exposing their content", async () => {
  const fetchImpl = (() => Promise.resolve(Response.json({
    errors: [{ message: "private provider detail" }],
  }))) as typeof fetch
  await expectCode("tracker_graphql", fetchImpl)
})

test("classifies malformed JSON and missing data as invalid payload", async () => {
  const malformed = (() =>
    Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch
  await expectCode("tracker_payload", malformed)
  const missing = (() => Promise.resolve(Response.json({ errors: [] }))) as typeof fetch
  await expectCode("tracker_payload", missing)
})

test("returns successful GraphQL data and preserves the existing auth shape", async () => {
  await withLinearToken(async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "token")
      assert.ok(init?.signal)
      return Promise.resolve(Response.json({ data: { viewer: { id: "viewer" } } }))
    }) as typeof fetch
    assert.deepEqual(await linearGraphql<{ viewer: { id: string } }>(query, {}, fetchImpl),
      { viewer: { id: "viewer" } })
  })
})
