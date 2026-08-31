# Project Alpha tombstone consumer rollout

This branch deliberately separates protocol and storage preparation from the
destructive reconciliation step.

## Safe preparation present here

- schema v1 remains limited to reversible `upsert` and `revoke` events;
- schema v2 accepts only an explicit `tombstone` with an empty, strict
  `data` object;
- migration `0049` adds immutable, PII-free evidence keyed by exact
  source/event/entity identifiers, source and event timestamps, and payload
  hash;
- schema-v2 events are rejected before any v1 projection writes until the
  reconciliation transaction below is explicitly authorized and implemented.

Absence from a snapshot and `active=0` never imply deletion. A later upsert
must not silently relink a tombstoned record.

## Pending authorization: mutating reconciliation

The following behavior is intentionally **not implemented in this branch**.
For an accepted schema-v2 tombstone, one source-qualified, fenced transaction
would:

1. append immutable tombstone evidence;
2. deactivate the exact Project Alpha source record;
3. revoke/suspend the exact record's primary portal access;
4. unlink only the exact `business_party_link`;
5. keep the business party active when any surviving source link remains, or
   close it when no surviving link remains.

That transaction also needs event replay, source-update ordering, connector
revision, and cross-source fences. No automatic relink is allowed on a later
upsert. These actions can revoke access and close records, so they remain
blocked pending explicit user authorization.

## Migration order and release gate

Production currently has Operations migrations `0032` through `0047`
pending, while service requests reserve `0048`. Apply `0049` only after all
of those migrations, and before enabling a Project Alpha schema-v2 producer.

Do not deploy the parser by itself as a completed consumer. The guarded parser,
evidence migration, authorized reconciliation transaction, producer enablement,
and rollback/visibility checks must move through release review in that order.
No migration or deployment is performed by this branch.
