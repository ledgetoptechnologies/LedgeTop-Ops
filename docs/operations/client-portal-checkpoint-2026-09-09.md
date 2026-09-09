# Client portal checkpoint — September 9, 2026

This is a partial acceptance record, not completion or deployment approval.

## Browser evidence

The authenticated Operations Client Hub loaded and reported 24 clients in its
first page. Both Project Alpha source filters were available. Primary-source
records displayed **Automatic workspace pending**; secondary-source records
displayed **Portal unavailable for this source**. Business-directory visibility
does not establish portal provisioning or successful source delivery.

Both Project Alpha integration tabs retained their previously rendered status
but displayed **Session expired**. Those retained status values are not a fresh
server check. Reauthentication is required before verifying current readiness,
pending/failed projections, or initiating recovery. No keys were rotated and no
replacement snapshots were queued during this check.

The Operations Incoming page still displayed the legacy verifier-wait message
for an existing ZIP upload. The rclone-native increment is local, not deployed.
See [the Incoming runbook](../truenas/incoming-rclone.md) for its exact TrueNAS
contract and activation gates.

## Local PA diagnostic investigation

The workspace reconciliation and portal-delivery cron scripts load database
configuration directly, not the web application's dotenv loader. The web
dotenv overwrite issue is therefore not a demonstrated cause of cron-only
preflight failures. Do not rotate credentials or change environment-file
precedence on that assumption.

A local, narrowly scoped diagnostic reports fixed categories for runtime-key
presence and encrypted-credential readability only. Its test/release review is
still in progress; it is not deployed evidence or a confirmed cause. Do not
record key values, fingerprints, ciphertext or credential fields in reports.

## Remaining gates

- Restore PA browser authentication and verify fresh producer/receiver state.
- Prove primary and secondary workspace delivery independently, then exercise
  default-on historical provisioning and revocation persistence.
- Verify service-driven access and explicitly scoped delivery with individually
  identified clients; do not infer access from directory or producer counts.
- Complete the Incoming full suite and coordinated retention/migration/path
  rollout before enabling its publication gate.
- GitHub CLI currently reports its configured login invalid; publishing awaits
  restored authentication. No alternate credentials were extracted.

The full [goal acceptance checklist](client-portal-goal-acceptance.md) remains
authoritative for scope. These observations do not accept its joined workflows.
