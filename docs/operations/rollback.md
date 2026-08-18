# Development rollback

Rollback is bounded to development and preserves every durable record.

1. Disable the Symphony Control Plane project mapping; do not delete run history.
2. Stop the new host unit and restore the previous unit and environment-file backup.
3. Restore the previous repository/base mapping only for work whose exact durable identity predates cutover.
4. Redeploy the previously recorded development Edge Function hashes if the new functions were deployed.
5. Verify the four table counts did not decrease and no work ID gained a second host identity.
6. Leave the seven migration versions in both git histories and in the development migration ledger.

Rollback never drops `momi_agent_ops`, rewrites a migration, deletes a ledger, or activates production. A failed or ambiguous host start remains blocked for operator reconciliation.
