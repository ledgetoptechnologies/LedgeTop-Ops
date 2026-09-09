# Delegated-share expiry scheduler health

Migration `0210_client_delegated_share_expiry_health.sql` adds one durable,
component-specific row for the hourly Client delegated-share expiry
reconciliation. It does not enable delegated shares, grant authority, or alter
the request-time expiry checks.

The worker records the last scheduled attempt, completion time of the last successful run, a
finite safe failure category, the latest bounded expiry counts, and whether
either fifty-row reconciliation pass reached its limit. `shares_at_limit=1` or
`delegations_at_limit=1` means more elapsed rows may remain for a later hourly
pass; it is not a count of the full backlog. `last_success_at` deliberately
remains unchanged after a failed attempt. Overlapping cron runs are fenced, so
an older completion cannot replace a newer run's state.

Until an authorized diagnostics endpoint is added, Operations may use this
read-only, aggregate-only D1 query during an approved maintenance window:

```sql
SELECT last_run_at,last_success_at,last_error_code,last_shares_expired,
       last_delegations_expired,shares_at_limit,delegations_at_limit,updated_at
FROM client_delegated_share_expiry_health
WHERE id='client-delegated-share-expiry';
```

The only persisted failure categories are `schema-unavailable` and
`reconcile-failed`; no exception text, identity, link, token, path, or other
share data is stored. During a rolling deployment before migration 0210 is
applied, the worker emits only the `schema-unavailable` health-log category and
still runs normal expiry reconciliation. Apply the migration before treating
the component health row as available.
