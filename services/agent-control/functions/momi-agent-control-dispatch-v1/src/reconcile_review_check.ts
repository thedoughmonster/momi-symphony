import type { Sql } from "postgres"

import type { ReviewProfile } from "../../../src/independent_review.ts"
import type { GitHubReviewGateway } from "./github_review_gateway.ts"

export type ReviewProjectionSubject = {
  implementationDispatchId: string
  repository: string
  pullRequestNumber: number
  headSha: string
  baseSha: string
  policyVersion: string
  profile: ReviewProfile
  reviewRequired?: boolean
}

export async function reconcileReviewCheck(sql: Sql, github: GitHubReviewGateway,
  subject: ReviewProjectionSubject): Promise<"success" | "pending" | "failure"> {
  return withTransaction(sql, async (transaction) => {
    const locked = await transaction<{ locked: boolean }[]>`
      select momi_agent_ops.lock_current_review_subject_v1(
        ${subject.implementationDispatchId}::uuid, ${subject.repository},
        ${subject.pullRequestNumber}) as locked`
    let state: "success" | "pending" | "failure" = "failure"
    if (locked[0]?.locked === true && subject.reviewRequired === false) state = "success"
    else if (locked[0]?.locked === true) {
      const authority = await transaction<{ authorized: boolean }[]>`
        select exists(select 1 from momi_agent_ops.current_review_authority_v1(
          ${subject.implementationDispatchId}::uuid, ${subject.repository},
          ${subject.pullRequestNumber}, ${subject.headSha}, ${subject.baseSha},
          ${subject.policyVersion}, ${subject.profile})) as authorized`
      if (authority[0]?.authorized === true) state = "success"
      else {
        const pending = await transaction<{ pending: boolean }[]>`
          select exists(
            select 1 from momi_agent_ops.dispatches work
            join momi_agent_ops.run_records run on run.dispatch_id = work.dispatch_id
            join momi_agent_ops.review_attempts review
              on review.implementation_dispatch_id = work.dispatch_id
            where work.dispatch_id = ${subject.implementationDispatchId}::uuid
              and work.work_status in ('writeback_pending', 'active')
              and work.cancellation_requested_at is null and work.cancelled_at is null
              and run.pull_request_number = ${subject.pullRequestNumber}
              and run.head_sha = ${subject.headSha}
              and run.validation_state = 'succeeded' and run.validation_sha = ${subject.headSha}
              and review.repository = ${subject.repository}
              and review.pull_request_number = ${subject.pullRequestNumber}
              and review.head_sha = ${subject.headSha} and review.base_sha = ${subject.baseSha}
              and review.policy_version = ${subject.policyVersion}
              and review.profile = ${subject.profile} and review.state = 'pending'
          ) as pending`
        if (pending[0]?.pending === true) state = "pending"
      }
    }
    await github.projectReviewCheck(subject.repository, subject.headSha, state,
      state === "success" && subject.reviewRequired === false
        ? "Independent review is not required by the risk policy for this exact head"
      : state === "success" ? "Independent review authority is current for this exact head"
      : state === "pending" ? "Independent review is pending for this exact head"
      : "No valid independent review authority exists for this exact head")
    return state
  })
}

async function withTransaction<T>(sql: Sql,
  callback: (transaction: Sql) => Promise<T>): Promise<T> {
  const begin = (sql as Sql & {
    begin?: (fn: (transaction: Sql) => Promise<T>) => Promise<T>
  }).begin
  return typeof begin === "function" ? begin.call(sql, callback) : callback(sql)
}
