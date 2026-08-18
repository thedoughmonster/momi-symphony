import assert from "node:assert/strict"
import test from "node:test"

import { readLinearAccessToken } from "../src/read_linear_access_token.ts"

test("uses the installed Linear secret name with canonical fallback", () => {
  const priorDeno = Object.getOwnPropertyDescriptor(globalThis, "Deno")
  try {
    Object.defineProperty(globalThis, "Deno", { configurable: true,
      value: { env: { get: (name: string) => ({ LINEAER_ACCESS: "installed",
        LINEAR_API_KEY: "fallback" })[name] } } })
    assert.equal(readLinearAccessToken(), "installed")
    Object.defineProperty(globalThis, "Deno", { configurable: true,
      value: { env: { get: (name: string) => name === "LINEAR_API_KEY"
        ? "fallback" : undefined } } })
    assert.equal(readLinearAccessToken(), "fallback")
  } finally {
    if (priorDeno) Object.defineProperty(globalThis, "Deno", priorDeno)
    else Reflect.deleteProperty(globalThis, "Deno")
  }
})
