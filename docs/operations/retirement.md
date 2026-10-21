# Reversible legacy workflow retirement

This procedure applies only to the repository-owned development dispatch wake
trigger. It is an operator operation in the existing protected deployment workflow,
not a migration-history shortcut. It does not activate services, delete data or
functions, change credentials or grants, or affect unrelated alerting integrations.

## Prerequisites and execution

1. Obtain explicit retirement authorization and merge the reviewed change only
   after required checks pass. Select that exact `main` commit.
2. Through the existing authorized operator route, stop new legacy work and
   disable its mappings, scheduler and decision-delivery policies, and dispatch
   recovery job. Reconcile any outstanding host work or callbacks. This public
   procedure contains no environment-specific operator payload or live receipt.
3. Run `Deploy development` with `phase=retirement`, the exact reviewed commit,
   and the default `runtime_function=all`. The protected environment and pinned
   development target remain required. No activation health drill or host restart
   is part of this phase.
4. Require the fixed runner's receipt and perform an authorized read-only
   verification of the target trigger. If the call fails or the response is
   uncertain, inspect state first. Never automatically repeat the mutation.

The job rejects a non-owner repository, non-main ref, non-manual event, or
commit mismatch before any secret-bearing step. The runner independently checks
the linked development project, rejects a conflicting `SUPABASE_PROJECT_ID`
override, pins that override in the CLI subprocess, and rejects managed password variables. It uses
the existing access-token path and never prints raw CLI output.

## Fixed transaction and receipt

The runner loads only
`20261021154309_disable_retired_agent_dispatch_trigger.sql`, whose canonical LF
checksum is pinned in `scripts/retirement_sql.ts`. A content change fails closed
until its checksum and tests are reviewed together. No earlier migration is
loaded or executed. Historical files remain unchanged.

The transaction locks the checked application tables before validating inactive
controls and the absence of pending dispatches, accepted or active work without
terminal evidence, occupied or quarantined slots, pending reviews, pending
decision delivery, and a current scheduler lease. The wrapper also requires the
named dispatch recovery job to be disabled. It reads that job without altering it;
coordinate against concurrent administrative reactivation.

Only the exact named trigger on the exact owned table and function is disabled.
A catalog snapshot and postcondition preserve every other trigger, including
bookkeeping triggers, and the target's other attributes. Histories are unchanged.
The fixed transaction writes neither the shared nor private migration ledger.
Unrelated pending migrations therefore remain pending.

A successful workflow log contains only the operation name, exact release commit,
canonical SQL checksum, `trigger_disabled: true`, and
`other_triggers_preserved: true`. It does not publish mapping IDs, host addresses,
work payloads, or runtime records. Missing or malformed confirmation is an
uncertain outcome, even if the database may already have committed.

Server timeouts are 2 seconds for lock acquisition and 10 seconds per statement;
the CLI subprocess has a 60-second deadline and no automatic retry. A client
deadline does not prove server rollback. The normal migration remains in order
and is idempotent if a later, separately authorized release reaches it. Do not
record it early, reorder history, or apply unrelated versions to satisfy parity.

## Verification and reversal

Synthetic tests cover guarded rejection, exact trigger identity, preservation,
rollback on postcondition failure, canonical checksums, workflow boundaries,
bounded invocation, and uncertain receipts. Optional PGlite tests use only a
synthetic local fixture and an existing module supplied by `MOMI_PGLITE_MODULE`;
they do not establish real multi-session locking or hosted execution.

Required Linux CI also runs the retirement wrapper against the full historical
schema in disposable PostgreSQL. It verifies active-producer rejection, a
competing-session lock timeout, postcondition rollback, history preservation,
and replay. Legacy behavior tests explicitly stop at the last pre-retirement
migration; the dedicated test covers the later shutdown without weakening it.

Re-enabling the trigger or any producer requires fresh explicit authorization
and an outstanding-work check. Retirement alone does not prove that an external
host is stopped or that a webhook registration has been removed. Endpoint deletion
and security changes are separate actions, outside this procedure.
