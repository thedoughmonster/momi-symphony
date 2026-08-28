# Independent PR review

Independent review is required only when the exact pull-request diff crosses a named material
boundary: security/privacy, destructive migration, public contract, production exposure/cost,
concurrency/state integrity, or an explicit owner request (`independent-review` /
`independent review required` label or `Independent review: required` in the issue). The predicate
is deterministic and returns the matching trigger names. Incomplete or unfamiliar evidence alone
does not manufacture a high-risk classification. All other changes follow normal exact-head CI
and GitHub review; the owned policy check records that independent review was not required.

Risk-triggered review is a phase of the existing implementation lifecycle; it is not a second
scheduler, a Linear issue, or a review-debt queue.

After validation succeeds, agent-control reads the live pull request and creates one `pending`
attempt for the exact repository, PR, head, base, policy, and risk-derived profile. The only
terminal states are `accepted`, `changes_requested`, `failed`, and `canceled`. A head, base,
policy, profile, or current-dispatch mismatch makes a historical row non-current without mutating
that row. At most one attempt is pending per implementation, and at most one accepted attempt can
exist for an exact subject.

The reviewer runs through the separate reviewer App Server, OS identity, socket, `CODEX_HOME`,
repository, and read-only detached exact-head workspace. Its callback capability is AES-256-GCM
sealed at rest. Candidate-head `AGENTS.md` files are review data; governing rules are loaded from
the protected base. The implementation identity cannot access the reviewer credential or record
reviewer identity. Accepted results cannot contain blocking findings.

Risk-triggered attempts use the bounded `high` execution profile. Historical profile values remain
readable so policy rollback is independent from persisted state, but there is no automatic
low-to-standard-to-high ladder. Inconclusive or escalation output is a failed attempt requiring
manual intervention. A correction may
reuse the same independent reviewer only when the complete correction diff is confined to active
finding paths and base, policy, profile, and material risk are unchanged.

`momi_agent_ops.current_review_authority_v1` is the sole canonical current-state query. It returns
an accepted independent attempt only when it matches the current active, noncanceled implementation
and exact validated subject. Merge uses that answer once under the shared current-dispatch/per-PR
lock, alongside live exact-head CI, GitHub blockers, the trusted `Symphony Independent Review`
check, and branch-protection/bypass facts. When the predicate says independent review is not
required, the reducer omits independent-review authority but still requires exact-head CI, the
owned policy check, no authoritative changes-requested review, no unresolved review thread, and
non-bypassable protection. If eligible, the gateway submits the merge with the exact expected head
SHA. No merge-preflight receipt is persisted.

The GitHub review check is a deterministic projection and enforcement backstop, never review
authority. Its external ID is stable for repository and head; reconciliation updates the owned
check to in-progress, success, or failure from current database state. There are no publication
leases, check mirrors, revocation receipts, or proof-of-proof records. Every update holds the
shared subject lock while it rereads canonical authority and publishes, so an older success cannot
finish after a cancellation or other loss of authority.

Head change and lifecycle cancellation acquire the same lock domain used by merge, atomically
cancel pending attempts, and make current authority false before committing. Host interruption
and failure-check projection follow as idempotent best-effort cleanup. A late callback must still
win the `state = pending` compare-and-set and all current-parent/current-subject checks, so it
cannot restore canceled or obsolete authority. Recovery reports observed host state as running,
terminal, or missing. Running remains pending, terminal schedules callback replay, and only an
authenticated implementation retry after an observed missing record may fail the pending attempt
and create one replacement. If the host acceptance response was lost, the capability-authenticated
exact-subject terminal callback may atomically bind previously absent independent thread/turn
identity while completing the pending attempt. An ambiguous start lacking its exact new thread and
turn pair is always reported missing; prior turns on a reused reviewer thread are never recovery
evidence for a new subject. Recovery never synthesizes acceptance.

Agent State derives `reviewing` from the current exact-head attempt rather than a copied review
mirror. The merge path alone consumes canonical review authority; successful terminalization
requires its resulting actual merge SHA and successful release evidence rather than rebuilding a
second review predicate. Runtime receipts expose whether review was required and the exact trigger
set. Development rollout uses only
`.github/workflows/deploy-dev.yml`; production promotion is not authorized by this procedure.
