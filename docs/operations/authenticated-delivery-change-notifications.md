# Exact authenticated-delivery change notifications

This capability sends a short, delayed summary when files change inside a
folder that has one current, exact-principal authenticated-delivery grant. It
does not broaden delivery access and it does not replace either Project Alpha
delivery-intent mail or the legacy client-folder subscription system.

## Rollout and ownership

- `AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED` defaults to `false`.
- Migration `0170_authenticated_delivery_change_notifications.sql` creates no
  preference rows and performs no enabling backfill.
- A staff action must create an explicit preference for one immutable grant
  version and its exact identity/principal recipient.
- Group, organization, department, client, project, contact, and dynamic
  membership audiences are not expanded into recipients.
- Project Alpha intent/outbox rows and legacy notification preferences retain
  their existing independent producers, claims, retry budgets, and mail.

## Event boundary

The only production staging call is in the shared R2 `consumeFileEvents`
consumer. A create is considered after a current `HEAD` succeeds and
`file_index` contains that exact ETag. A remove is considered only after the
replacement-safe delete handler proves that no live replacement owns the key
and completes its index transition. Browser upload completion and individual
upload routes never stage mail.

The event timestamp must not predate either the grant or preference. A delayed
create whose event ETag no longer matches the authoritative `HEAD` is ignored.
The per-grant/recipient object-version ledger makes exact queue replay a no-op,
accepts a new replacement version, and collapses an add followed by a remove
inside the grace window to an empty cancelled batch.

## Recipient and batch rules

Candidates are considered independently for each exact identity. The unique
longest matching active prefix wins. Two distinct grants at the same longest
prefix are ambiguous and stage nothing. An open batch is keyed by immutable
grant version, exact recipient, and current preference version, waits five minutes, and accepts at most 50
objects. Item 51 starts a successor; a claimed/sealed batch never absorbs more
changes.

The preference stores two independent decisions:

- `access_notice_enabled` is an explicit master opt-in.
- `change_mode` is `off`, `added`, `removed`, or `both`.

Disabling the master opt-in forces `change_mode=off`. Policy mutations are
actor-scoped and idempotent, require an optimistic policy version, and append
immutable audit. Staff batch `send-now` and `cancel` controls use the same
actor-scoped replay and compare-and-swap pattern.

## Final authorization

Before publication and again immediately before provider submission, dispatch
rechecks all of the following against current Delivery data:

- immutable workspace source reservation and active workspace;
- current complete directory generation and exact binding owner/version;
- active exact grant ID/version, principal snapshot, recipient identity, and
  grant/access-term expiry;
- active principal, verified identity, membership, `delivery.view` allow, no
  matching entitlement deny, and no matching identity denial;
- unchanged enabled preference/version and subscribed change modes;
- longest-prefix uniqueness and containment of every item;
- exact `file_index` ETag for present items and absence for removed items; when
  the R2 binding is available, the live object `HEAD` is checked too;
- current lease ownership immediately before mail submission.

Failure suppresses the batch without sending. Provider submission is
at-least-once across an unknowable provider-acknowledgement failure, but sealed
content and the deterministic Message-ID remain stable across retries. Leases
are bounded, attempts stop at three, and audit/log reasons do not include raw
paths, emails, or provider errors.

## Verification

`authenticated-delivery-change-notifications.test.ts` applies the populated
Delivery migration chain through 0169 before 0170, verifies no opt-in backfill,
and covers policy replay/version routing, 40/51 batching, duplicate/replacement/
delayed and add-delete sequences, longest-prefix ambiguity, grant revocation,
binding status/version, active-generation/owner/principal/identity changes,
membership expiry, entitlement and identity denials through enabled hierarchy
relations, entitlement-term expiry, policy/object changes, escaped
mail presentation, complete stage/claim/terminal audit, stable retry Message-ID,
final authorization races, send-now/cancel serialization, and legacy/Project
Alpha compatibility. Source ownership and grant-version mutation are tested as
structurally rejected by the populated migration chain; the final authority SQL
still independently requires those exact snapshots at dispatch.
