# Canonical Agent State projection

`momi_agent_ops` is the canonical execution record. Linear's `Agent State`
label is a repairable, output-only projection and never participates in action
selection, readiness, candidate generation, capacity, or dispatch authority.

The `agent-state-v2` pure reducer `deriveAgentState` maps exact current-generation
evidence to one of `queued`, `checking`, `working`, `validating`, `reviewing`,
`releasing`, `waiting`, `failed`, `stopped`, `complete`, or `coordinating`.
Scheduler reservation projects `queued`; dispatch claim and host acceptance
project `checking` and `working`. Retry, cancellation, and the durable execution
receipt drive their corresponding exceptional or terminal states. Linear
writeback has a separate projection lifecycle and cannot change a successful
execution into failure. The existing scheduler pump also reprojects current runs, repairing a
manually deleted or changed label without starting work or a model turn.

The projector fresh-reads the issue and the complete team label catalogue. It
recognizes state labels only when their parent group is exactly `Agent State`,
removes every stale member of that group, preserves every unrelated label, adds
the one derived member, and records the projected label ID. A post-write ledger
fence refuses stale generations. A newer run can therefore supersede an older
callback; a race may be visible only until the newer run's immediate or periodic
repair.

## Exact delivery evidence

Authenticated structural receipts use the existing dispatch callback boundary
with `event=lifecycle_evidence`. A receipt is bound to the durable work,
capability, host thread/turn, repository/base, branch, pull request number, and
exact revision. Each receipt carries the authoritative prior revision (null only
before the first head); controlled head changes compare-and-set that value while
holding the same per-issue transaction fence used by new dispatch creation.
Validation and review receipts must match the recorded head SHA;
release receipts must match the merge SHA. Conflicting identities, terminal
receipt rewrites, stale generations, and unrelated workflow activity fail
closed. Receipt details remain private in `momi_agent_ops`; Linear receives only
the derived state label.

`complete` requires a ready/completed durable execution receipt and successful
or explicitly non-applicable delivery obligations. It does not require successful
Linear projection.
No free-form summary, checkpoint, telemetry row, or model statement can advance
the lifecycle.

## Execution and projection transitions

| Durable event | Execution status | Linear projection status | Retry behavior |
| --- | --- | --- | --- |
| Dispatch created | `pending` | `pending` | No terminal projection is eligible. |
| Host accepted | `running` | `pending` | Execution proceeds under the existing bounded lease. |
| Terminal callback recorded | `succeeded`, `failed`, or `interrupted` | `pending` | Execution is final before any Linear request. |
| Projection lease claimed | unchanged | `in_progress` | A ten-minute database lease and monotonic attempt generation fence concurrent and reclaimed workers while covering the bounded Linear request sequence. |
| Linear comment/state/Agent State succeeds | unchanged | `succeeded` | Receipt records the comment and completion time. |
| Linear projection fails | unchanged | `retryable`, then `failed` after eight attempts | Scheduler backoff retries without a host call or model turn; explicit replay can requeue `retryable` or `failed`. |
| A newer issue generation supersedes the run | unchanged | `superseded` | The stale run cannot overwrite the current generation. |

The authenticated `projection_replay` event accepts one to fifty explicit
dispatch IDs. It only requeues and reconciles terminal projection; it cannot
claim scheduler work or rerun code. Scheduler pump receipts expose aggregate
projection retries and failures, while private `run_records` retain attempts,
next-attempt time, lease, bounded error code, and completion evidence.
Projection results must present the attempt generation returned by claim while
that lease is unexpired. An expired worker cannot record over a reclaimer even
if its Linear requests finish later.

## Development verification and rollback

After the protected development release, verify one bounded run records the
expected reservation/claim/host states and an exact-revision receipt sequence.
Remove its projected label once, run the existing scheduler pump, and confirm the
same label is restored without a new dispatch. Verify an older dispatch cannot
record or project over the current generation.

Rollback deploys the previous dispatch runtime and disables new scheduler claims
before any investigation. A database trigger keeps terminal callbacks from the
previous `record_terminal_v5` runtime compatible by deriving the v2 execution and
projection statuses in the same terminal transaction. The additive migration backfills completed executions
from terminal receipts and successful projections from existing writeback receipts;
it does not rewrite or delete an existing run. Do not delete the lifecycle columns,
delivery receipts, or projection audit fields. They are durable evidence. Existing runs remain on
their exact cancellation, recovery, and terminal paths; production promotion is
not authorized.
