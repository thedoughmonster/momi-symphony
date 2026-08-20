# Canonical Agent State projection

`momi_agent_ops` is the canonical execution record. Linear's `Agent State`
label is a repairable, output-only projection and never participates in action
selection, readiness, candidate generation, capacity, or dispatch authority.

The versioned pure reducer `deriveAgentState` maps exact current-generation
evidence to one of `queued`, `checking`, `working`, `validating`, `reviewing`,
`releasing`, `waiting`, `failed`, `stopped`, `complete`, or `coordinating`.
Scheduler reservation projects `queued`; dispatch claim and host acceptance
project `checking` and `working`. Retry, cancellation, terminal receipt, and
terminal Linear writeback drive their corresponding exceptional or terminal
states. The existing scheduler pump also reprojects current runs, repairing a
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
exact revision. Validation and review receipts must match the recorded head SHA;
release receipts must match the merge SHA. Conflicting identities, terminal
receipt rewrites, stale generations, and unrelated workflow activity fail
closed. Receipt details remain private in `momi_agent_ops`; Linear receives only
the derived state label.

`complete` requires a ready/completed terminal receipt, successful or explicitly
non-applicable delivery obligations, and successful terminal Linear writeback.
No free-form summary, checkpoint, telemetry row, or model statement can advance
the lifecycle.

## Development verification and rollback

After the protected development release, verify one bounded run records the
expected reservation/claim/host states and an exact-revision receipt sequence.
Remove its projected label once, run the existing scheduler pump, and confirm the
same label is restored without a new dispatch. Verify an older dispatch cannot
record or project over the current generation.

Rollback deploys the previous dispatch runtime and disables new scheduler claims
before any investigation. Do not delete the lifecycle columns, delivery receipts,
or projection audit fields. They are durable evidence. Existing runs remain on
their exact cancellation, recovery, and terminal paths; production promotion is
not authorized.
