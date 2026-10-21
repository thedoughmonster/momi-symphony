# Symphony Control Plane Agent Contract

## Ownership

This repository is the sole executable owner of `agent-control`,
`agent-control-host`, their Edge Function adapters, development deployment,
and every future change to the private `momi_agent_ops` schema.

## Hard rules

- Work from an explicitly authorized task or reviewed pull request; no tracker is mandatory.
- Use feature branches; protect `main` and require the `CI` status check.
- Keep `symphony-evaluation` disposable and independent from this repository.
- Never add another scheduler or another path that invokes Symphony.
- Unknown, missing, inactive, duplicated, or mismatched project mappings fail closed.
- Accept only authenticated canonical host commands and exact repository/base mappings.
- Preserve durable dispatch, host, cancellation, recovery, and callback identities.
- Never log prompts, webhook payloads, capability tokens, API keys, or bearer secrets.
- Keep secrets in GitHub/Supabase/operator stores, never in git.
- The seven imported migrations are an immutable applied-development baseline.
- Only this repository may add future `momi_agent_ops` migrations after cutover.
- Only `.github/workflows/deploy-dev.yml` may apply development migrations or deploy Edge Functions.
- Production deployment, promotion, or repository authority is not granted here.
- Run focused tests while iterating and `pnpm check` before handoff.
- Keep handwritten TypeScript files focused and independently testable.
- Change downstream readiness, discovery-finalization, scheduler, or Slack-alert semantics only within explicit recorded task scope.

## Delivery

- Pull requests must describe the authorized scope, tests and rollback impact.
- Development release is manual, environment-gated, and limited to the configured development project.
- Never merge or deploy to production without separate explicit approval for that action.
