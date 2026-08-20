# Agent control host adapter

## ELI5

This private adapter is the last guarded door before a Codex task appears. It
writes a reservation to a mode-0600 ledger before asking the existing local
Codex App Server to start anything. A repeated or ambiguous request therefore
cannot make a second task.

The adapter accepts only authenticated canonical dispatches. Repository and
base-branch values must match host configuration. One-shot work issues
`thread/start` and `turn/start`, listens for terminal `turn/completed`, calls
`thread/archive`, and posts one retryable terminal receipt to the agent-control
Edge Function. Interactive discovery names the thread before its first turn,
leaves it unarchived after normal turn completion, and retains its exact identity
for later user turns.
The separate authenticated cancellation contract resolves a sorted, bounded set
of exact work records owned by one lifecycle and calls `turn/interrupt` after
successful durable lookup. A retained
interactive task is archived directly and emits its terminal receipt. Queued
cancellation remains in the database owner, while a terminal target is an
idempotent host success.
The recovery contract resolves only one exact retained discovery record. It
reads the retained thread, interrupts its sole active turn when present,
confirms no turn remains active, and archives the thread. Archive failure leaves
the original record retained and replayable; recovery never starts a task.
Task acceptance returns before the post-start recovery read; a retry with the
same work identity promotes known thread/turn IDs and resumes terminal recovery
without starting a second task. Startup recovery also resumes subscriptions for
interactive tasks retained across a host restart. Immediate race recovery uses a
non-resuming `thread/read` so it cannot interrupt the turn it just started.
The adapter connects to the managed App Server daemon through its private Unix
WebSocket. After an interactive turn ends, it unsubscribes its connection so the
Codex sidebar can own later turns.
Because this headless boundary has no approval UI, accepted turns explicitly use
non-interactive approval and full host access. Keep it behind bearer auth, exact
repository/base mapping, and a dedicated operator-controlled workspace.

Run with `pnpm agent-control:host` only after configuring the callback, host
secret, workspace root, repository/base, ledger path, and an installed Codex
App Server daemon. Put any public TLS/reverse-proxy boundary outside this
process. The adapter never logs request bodies, prompts, or capability tokens.

New dispatches use the v3 compact transport: stable action rules and volatile
attempt context are separate input items with durable fingerprints and a typed
budget. Terminal callbacks include bounded usage telemetry; full tool output is
replaced by redacted, artifact-linked receipts. See
[`docs/operations/execution-efficiency.md`](../../docs/operations/execution-efficiency.md).

When explicitly enabled after the protected development acceptance, this same
process owns the sole scheduler timer. `MOMI_AGENT_CONTROL_RELEASE_SHA` must be
the exact protected 40-character commit under acceptance. The pump posts only
that release identity, a random scheduler owner UUID, and at most 128 active
durable work IDs to the existing authenticated agent-control callback. It never
receives or interprets Linear/provider data, never decides readiness, and never
creates a second App Server path. The database policy remains the final
enabled/observe/disabled authority.

The deterministic smoke test substitutes an in-memory App Server transport.
PR handoff also requires one no-side-effect acceptance event against the
installed local App Server; hosted activation remains post-review.
