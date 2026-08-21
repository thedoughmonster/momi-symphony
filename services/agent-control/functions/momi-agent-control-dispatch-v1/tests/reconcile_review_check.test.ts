import assert from "node:assert/strict"
import test from "node:test"
import type { Sql } from "postgres"

import { REVIEW_POLICY_VERSION } from "../../../src/independent_review.ts"
import type { GitHubReviewGateway } from "../src/github_review_gateway.ts"
import { reconcileReviewCheck } from "../src/reconcile_review_check.ts"

const subject = { implementationDispatchId: "00000000-0000-4000-8000-000000000001",
  repository: "thedoughmonster/momi-symphony", pullRequestNumber: 16,
  headSha: "a".repeat(40), baseSha: "b".repeat(40),
  policyVersion: REVIEW_POLICY_VERSION, profile: "high" as const }

test("review check projection rereads canonical authority while holding the subject lock",
  async () => {
    let inTransaction = false
    let authority = true
    const projected: string[] = []
    const transaction = ((strings: TemplateStringsArray) => {
      const query = strings.join("?")
      if (query.includes("lock_current_review_subject_v1")) return Promise.resolve([{ locked: true }])
      if (query.includes("current_review_authority_v1")) {
        return Promise.resolve([{ authorized: authority }])
      }
      return Promise.resolve([{ pending: false }])
    }) as unknown as Sql
    const sql = transaction as Sql & { begin: <T>(callback: (tx: Sql) => Promise<T>) => Promise<T> }
    sql.begin = async (callback) => {
      assert.equal(inTransaction, false)
      inTransaction = true
      try { return await callback(transaction) } finally { inTransaction = false }
    }
    const github = { projectReviewCheck: (_repository: string, _head: string, state: string) => {
      assert.equal(inTransaction, true); projected.push(state); return Promise.resolve({})
    } } as unknown as GitHubReviewGateway

    assert.equal(await reconcileReviewCheck(sql, github, subject), "success")
    authority = false
    assert.equal(await reconcileReviewCheck(sql, github, subject), "failure")
    assert.deepEqual(projected, ["success", "failure"])
  })
