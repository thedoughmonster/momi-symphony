# Agent control host adapter

## ELI5

This private adapter is the last guarded door before a Codex task appears. It
writes a reservation to a mode-0600 ledger before asking the existing local
Codex App Server to start anything. A repeated or ambiguous request therefore
cannot make a second task.

The adapter accepts only authenticated canonical dispatches. Repository and
base-branch values must match host configuration. It issues `thread/start` and
`turn/start`, listens for terminal `turn/completed`, calls `thread/archive`, and
posts one retryable terminal receipt to the agent-control Edge Function.
Task acceptance returns before the post-start recovery read; a retry with the
same work identity promotes known thread/turn IDs and resumes terminal recovery
without starting a second task. Startup recovery performs the same promotion
for a known task retained across a host restart.
Because this headless boundary has no approval UI, accepted turns explicitly use
non-interactive approval and full host access. Keep it behind bearer auth, exact
repository/base mapping, and a dedicated operator-controlled workspace.

Run with `pnpm agent-control:host` only after configuring the callback, host
secret, workspace root, repository/base, ledger path, and an installed Codex
App Server daemon. Put any public TLS/reverse-proxy boundary outside this
process. The adapter never logs request bodies, prompts, or capability tokens.

The deterministic smoke test substitutes an in-memory App Server transport.
PR handoff also requires one no-side-effect acceptance event against the
installed local App Server; hosted activation remains post-review.
