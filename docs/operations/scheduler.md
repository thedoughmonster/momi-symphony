# Ready-leaf scheduler operations

## Ownership and default state

There is one scheduler timer, inside `agent-control-host`, and one durable
policy/queue/lease authority in `momi_agent_ops`. The host calls only the
existing authenticated agent-control function and sends no provider data.

Both gates default off:

- `MOMI_AGENT_CONTROL_SCHEDULER_ENABLED=false` prevents the host timer;
- `momi_agent_ops.scheduler_route_policies.mode='disabled'` prevents leader
  acquisition, provider reads, and claims even if a pump request is replayed.
- enabled host pumps must present `MOMI_AGENT_CONTROL_RELEASE_SHA`, and enabled
  database routes accept only the exact SHA recorded after protected acceptance.

Do not enable either gate during PR delivery, migration application, or runtime
deployment. Production is not an available target.

## Protected development acceptance

Acceptance requires an exact protected `main` SHA and separate coordinator
release. It must not select arbitrary real ready issues or create a new Linear
issue.

1. Confirm the exact-main CI and disposable PostgreSQL contention job are green.
2. Choose one existing, non-executable issue UUID explicitly approved for
   observation. Set the exact dedicated route to `observe` and set
   `acceptance_issue_ids` to that one UUID in the same guarded transaction.
   The table constraint rejects an empty or more-than-20 observe allowlist.
3. Temporarily enable the host pump and observe one sanitized receipt. Observe
   mode uses the adapter ID-refresh path, persists current readiness evidence,
   and cannot call the database claim function because that function requires
   `mode='enabled'`. Set `MOMI_AGENT_CONTROL_RELEASE_SHA` to the exact protected
   commit under acceptance; the pump contains that SHA but no provider data.
4. Prove candidate generation and atomic route/action capacity with the
   repository's disposable PostgreSQL fixture, including its explicit
   transaction-rollback assertion. No acceptance fixture dispatch
   may commit or reach `pg_net`.
5. Disable the host pump and apply
   `ops/sql/disable_ready_leaf_scheduler.sql`. Verify zero new scheduler-origin
   dispatches and slots for the observed issue.
6. Record the acceptance timestamp and exact 40-character release SHA only
   after reviewing the receipt. A later, separately authorized change may set
   `mode='enabled'` and clear the allowlist. The database constraint rejects
   enabled mode without both fields.

## Scheduling and recovery

Every enabled pump acquires a 30-second route-scoped leader lease. Candidate
fetch and ID refresh both consume the adapter's current `dispatchable` value.
Immediately before claim, the scheduler refreshes that exact issue again and
persists a new snapshot version. The atomic claim locks the route policy,
rechecks leader generation, mapping, active state, required labels, snapshot,
candidate generation, and freshness, counts active route/action slots, then
creates one slot and one existing `execute-run` dispatch in the same
transaction.

Priority ordering is `1..4` ascending, all other/null last, creation timestamp
oldest/null last, then identifier. No aging term participates.

An eligible generation that becomes ineligible before claim is stale. A later
false-to-true eligibility transition increments the generation. Claimed,
running, terminal, or stale generations cannot create a duplicate dispatch.
Terminal callbacks release slots. Active host ledger IDs heartbeat slots;
expired nonterminal slots without matching host evidence are quarantined and
continue consuming capacity until exact reconciliation. Provider failures use
bounded technical backoff and never become decision alerts.

## Observability

The pump response contains counts only: routes, observed candidates, claims,
and technical retries. Do not add issue bodies, labels, provider responses,
credentials, or work tokens to logs. Durable diagnosis comes from the private
route policy's mode/retry fields and aggregate candidate/slot generation states.
An enabled route with a future `next_provider_attempt_at` is in technical
backoff; `last_provider_error_code` is a bounded category, not a decision alert.
A `quarantined` slot is intentionally capacity-consuming until its exact
dispatch reaches a terminal state.
