# Independent PR review

Normal `execute-run` work keeps its implementation slot from dispatch through validation,
independent review, rework, merge, development release, and terminal Linear writeback. Review is
an internal lifecycle phase of the existing control plane; it is not a scheduler, Linear issue,
or detached debt queue.

After focused validation succeeds for a coherent PR head, agent-control fresh-reads the PR from
GitHub, selects the `low`, `standard`, or `high` profile from changed paths, freezes the exact
repository/PR/head/base/policy subject, and reserves one private review attempt. Sensitive or
ambiguous surfaces promote to `high`; there is no no-review profile. A bounded packet contains the
named issue, applicable `AGENTS.md` references, exact changed paths, an exact diff reference,
current-subject CI metadata, and unresolved finding identities when applicable. Implementation
transcripts, author reasoning, sibling-review prose, and unrelated history are excluded.
Applicable rules are loaded only from the protected base revision. Reviewer threads start in the
host-owned workspace harness, outside the candidate checkout; the exact candidate worktree is
mounted as read-only review data, and candidate-head `AGENTS.md` files never govern the reviewer.

The host's v4 review transport creates a new thread and turn on a reviewer-only App Server with the attested
`independent_reviewer` role. Its typed output is one of `accepted`, `changes_requested`,
`inconclusive`, or `escalate` plus compact findings. The reviewer cannot edit, push, merge,
release, change policy, or invoke Symphony. A reviewer capability is generated inside the private
ledger and is not available to the implementation task. The implementation callback credential
cannot record an accepted receipt or publish the dedicated GitHub status.
The host and reviewer App Server run under distinct `momi-agent-control` and
`momi-agent-reviewer` operating-system identities. The implementation App Server remains under a
third implementation identity. The
reviewer's `CODEX_HOME`, socket, session storage, ledger, and detached review workspaces live under
the reviewer state directory, accessible only to the reviewer identity and the host's narrow
`momi-agent-review` group. Exact review objects and worktree metadata come from a separate private
repository there and are never exposed to implementation turns. Both services
use `PrivateTmp=true`, so review workspaces intentionally do not use `/tmp`. The root-owned host
environment and AES-GCM credential are unreadable by the implementation identity. Missing,
overlapping, or non-private reviewer paths and missing credential material fail host startup closed.
Restart recovery reconnects reviewer records only through the reviewer daemon; implementation-side
App Server enumeration cannot address that daemon's thread namespace. Both services execute only
root-owned release binaries, never code or tools from the implementation user's writable checkout.

Canonical acceptance is the exact-generation `momi_agent_ops.review_attempts` receipt. Any head,
base, policy, or profile change makes it stale. A bounded fix may be reverified by the same
independent reviewer only when the controller proves every changed path is covered by the active
finding set and no material risk dimension changed; ambiguity requires a fresh reviewer. Accepted
results cannot contain blocking findings.
An `escalate` result creates a fresh reviewer attempt through a durable reviewer-authenticated
transition. Profiles promote only `low → standard → high`; each promotion has a new dispatch,
thread, turn, capability, and generation. Escalation at `high` records explicit exhaustion and
fails the review obligation instead of silently waiting or repeating the same profile.

The control plane projects accepted canonical evidence to the exact head as
`Symphony Independent Review` using the reviewer-only GitHub credential. Protect `main` with both
the existing CI requirement and this status, enforce protection for administrators, disallow force
pushes/deletion, and do not give implementation credentials permission to alter protection or
publish this context.

Immediately before merge, call the authenticated `merge_preflight` event. It fresh-reads the PR,
required CI, the dedicated status, authoritative review/request-changes state, and branch
protection; combines those facts with the exact accepted private receipt; and runs the pure
fail-closed reducer. Missing, stale, unknown, ambiguous, bypassable, or contradictory evidence is
ineligible. The implementation lifecycle cannot complete while an implementation PR lacks
exact-head validation, accepted review, the projected status, or applicable release evidence.

Development rollout uses only `.github/workflows/deploy-dev.yml`: apply the single owned migration,
deploy the dispatch Edge Function, then verify a clean review, changes-requested and bounded-fix
path, stale-head rejection, reviewer failure/recovery, and credential/bypass refusal. Production
promotion is not authorized by this procedure.
