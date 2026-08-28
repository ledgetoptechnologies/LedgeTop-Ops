# Exact authenticated-delivery change notifications

This capability sends a short, delayed summary when files change inside a
folder that has one current, exact-principal authenticated-delivery grant. It
does not broaden delivery access and it does not replace either Project Alpha
delivery-intent mail or the legacy client-folder subscription system.

## Rollout and ownership

- `AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED` defaults to `false`.
- Migrations `0170_authenticated_delivery_change_notifications.sql` and
  `0175_authenticated_delivery_notification_policy_consistency.sql` create no
  preference rows and performs no enabling backfill.
- The reviewed Operations policy editor, notification-center lane, Inbox
  projection, exact deep links, and Send Now/Cancel controls are implemented
  locally. They report the feature as unavailable while either the flag or
  migration is not ready; this does not silently enable any recipient.
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

## Staff workflow and authority

Operations resolves the physical authenticated-grant ID to its single stored
recipient. The browser never supplies an identity ID, recipient address, R2
prefix, source, workspace, or division. Policy reads and writes require a
current authenticated staff record plus division-scoped
`delivery.share.create`; the route rechecks the exact source-qualified grant
context and staff policy before returning. Enabling additionally requires a
currently usable principal, verified identity, active membership, and current
`delivery.view` authority. An existing policy can still be disabled after the
recipient or grant becomes inactive.

The combined notification center exposes this producer as
`authenticated_delivery`, separately from `folder_changes` and
`portal_delivery`. Combined pagination retains an independent encrypted scan
position for each producer and binds the cursor to the current staff identity,
permission proof, query, view, readiness flags, and expiry. Public rows contain
only display labels, counts, bounded status data, and the currently verified
recipient address; raw object keys, prefixes, provider failures, identities,
and authority coordinates are not returned.

Exact reads require `delivery.share.audit`. Send Now requires
`delivery.share.create`; Cancel requires `delivery.share.revoke`. Both actions
recheck the current scope and staff permission proof, use optimistic revisions
and actor-scoped idempotency, and change only the notification batch. They do
not add or revoke portal access, modify files, or recall a notice already
accepted by a mail provider.

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

The staff integration also has focused API/D1 coverage for default-off
readiness, exact grant/recipient resolution, division authority, policy replay
and stale versions, three-source combined pagination, bounded redacted
presentation, deep reads, and Send Now/Cancel replay. Operations browser tests
cover the default-off exact-person editor and the third notification lane on
the supported desktop and mobile projects. Production acceptance still
requires migrations 0170 and 0175, deliberate flag enablement, and a real cron/mail smoke
test with a rollback path.
