# Security and access

- Repository visibility is public by explicit operator decision after a complete
  reachable-history secret scan. Membership remains least privilege.
- `main` requires pull request review and the `CI` status check.
- GitHub secret scanning and push protection are enabled.
- GitHub Actions receives read-only repository contents by default.
- Development secrets are scoped to the protected `development` environment.
- Public fork pull requests run only secretless CI; they cannot invoke the
  environment-scoped manual development deployment.
- The host listens on loopback, requires bearer authentication for commands, and exposes only `/health` without auth.
- Linear signatures are verified over original bytes before payload parsing.
- The private schema is absent from the Data API and denies public, anonymous, authenticated, and service-role table access.
- Rotate or revoke the host bearer secret, Linear webhook secret/access token, Supabase token, and tunnel token independently. Restart only the affected boundary after rotation.
- Never copy a secret into an issue, log, test fixture, git file, or rollback record.
