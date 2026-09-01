# Native delivery notifications

Status: implemented and verified locally on August 26, 2026; not deployed or
live-verified.
This increment extends the existing folder-change notification center. It does
not change the Viewer, thumbnail workers, mail provider, or portal eligibility.

## Included and excluded producers

- Project Alpha delivery intents with an explicit portal principal and
  `notify: true` can stage a delivery-ready notice. The native audience is an
  existing exact principal/version, not an inferred email, business contact,
  organization member, or folder-name match.
- Folder-change subscriptions keep their existing batching and authorization.
- Earlier native notices that have already attempted dispatch, active or expired
  processing leases, and revocation notices remain on their existing direct
  lane. They are read-only in the staff center.
- Staff-created portal grants, general uploads without a recipient policy,
  group fan-out, recipient selection and subscriptions for native uploads are
  not implemented by this increment. A delivery-ready notice is not a count of
  added or removed files.
- The later
  [exact authenticated-delivery change notification](authenticated-delivery-change-notifications.md)
  increment does cover general R2 additions and removals for an explicitly
  opted-in, exact-principal grant. Uploads without that policy still send
  nothing. Group, contact, organization, department, client, and project
  fan-out remain deliberately unsupported; operational contacts never imply a
  notification subscription.
- Public-share mail, service-request mail and the other existing outboxes retain
  their current producer contracts. The staff center is not a universal mail log.

## Identity and staff visibility

New batches are qualified by source, workspace, folder binding/version and
principal/version. Items retain references to the original intent outbox and
grant. The authenticated portal is still responsible for checking access when
the recipient follows the link; notifications never grant access.

Public API records use `kind: folder_changes` or `kind: portal_delivery`.
Native staged IDs start with `nb_`; native direct-record IDs start with `nd_`.
The UI uses both kind and ID for row identity, exact links and mutation replay.
An old `?batchId=...` link remains strictly a folder-change notice. Native exact
links include `kind=portal_delivery`; they never guess the notification type.

Staff authority requires both the current division permission and an exact,
source-qualified match between the native owner's public ID and the validated
Operations projection. A matching R2 prefix alone is insufficient. Missing or
ambiguous public-ID mapping hides the record rather than exposing another
customer's notice. Department ownership has no safe Operations mapping in this
increment. The Alpha public-ID export is therefore a paired release prerequisite
for complete staff visibility; that separate release has not been approved here.

Native dispatch remains on the existing primary Alpha authority contract. The
business-data connector registry is not the mail ingress or portal authority:
hiding a business-data source is not equivalent to revoking portal access.
Previously supported `project_alpha`, `operations` and `legacy` binding kinds
remain supported under that same current primary ownership proof; a binding
kind alone never authorizes a recipient.

## Lifecycle and controls

Untouched native `granted` rows (pending, zero attempts, no lease) are adopted
atomically with their item and batch. New eligible intents use the same staging
contract. A unique outbox item prevents replay from restarting a cancelled or
sent notice. Newly staged events restart the five-minute quiet period; claiming
seals the batch and later events create another batch. Work is bounded and
resumable; the quiet period is not a five-minute email SLA.
Send Now also seals the batch, and a full 50-item batch is sealed before the next
item starts a successor. Those events cannot reopen or alter a published batch.

Send Now changes eligibility, not delivery confirmation or retry limits. Cancel
stops remaining attempts only while the batch is pending; it does not remove
files, revoke access or recall a message already accepted by the mail provider.
Both controls require current scoped permission, the displayed revision and an
actor-scoped idempotency key. Status, control receipt and audit commit together.

Dispatch revalidates source, active workspace/directory generation, binding,
owner, principal version, identity and live grants. Publication freezes the
validated authority and message fingerprint; changed retry context suppresses
the notice instead of retargeting it. Claims and completion are lease-token
fenced, with at most three attempts for the new staged lane. Existing attempted
direct notices retain their earlier identity and retry contract; they are not
retroactively represented as new batches.

SMTP and the two databases cannot share a transaction. Rechecks cannot recall
mail after provider acceptance or close every cross-database race. A crash after
acceptance can cause an at-least-once retry, even with a stable Message-ID.
"Sent" means accepted by the transport, not read or received in the inbox.

## Staff API and graceful upgrade

`GET /api/notifications/deliveries?format=combined` returns a bounded, typed feed
with `coverage: delivery_notifications_v2` and explicit availability for each
producer. The unchanged list without `format` retains the legacy contract.
Server-side merging uses encrypted, actor/permission/filter-bound continuation
cursors with an independent last-consumed position per feed. Empty authorized
pages can still have a continuation; the UI must not call those exhaustive.

Native detail is `/api/notifications/deliveries/portal_delivery/:id`; native
controls append `/send-now` or `/cancel`. Only the exact staged control routes
receive staff delegation, and the normal origin/CSRF checks still apply. Direct
notices cannot be controlled through those endpoints. No raw storage prefixes,
internal authority identifiers, lease tokens or provider errors belong in DTOs.

Apply Delivery migration `0161` after the existing chain, then the paired
Operations application. Before migration readiness, the combined view retains
folder notices and explicitly reports native coverage unavailable; it must not
claim native history is empty. Do not run old and new native dispatchers
concurrently: old code does not know the staged ownership ledger. Do not drop
the new tables to roll back. Pause affected dispatch and reconcile ownership
before an authorized rollback; prefer a forward fix.

Native staged and retained direct delivery notices run together in a dedicated
awaited invocation (`4-59/15 * * * *`), preserving the earlier 15-minute polling
cadence at an offset. They no longer share the consolidated bucket/thumbnail/
Viewer-maintenance invocation's query budget. No other maintenance job moves.
An eligible notice waits for the next tick, so five minutes is a quiet period,
not the expected delivery time. Send Now also waits for a tick. Deployment must
verify account-level trigger capacity; five entries in this application's local
configuration are not proof of capacity across the whole Cloudflare account.

## Verification and release gates

The scoped local gate passed:

- 25 migrated-D1 native staging/dispatch/control cases, including a populated
  upgrade, unchanged earlier outboxes, adoption races, frozen recipient identity,
  same-email identity rebinding, current grant/binding authority, concurrent
  control replay, live-lease exclusion, expired-lease takeover and stale
  completion, exactly three attempts, source-isolated exhausted cleanup, and
  50-to-51 item rollover. Production candidate query plans and bound-parameter
  limits are checked; the 50-scope read protocol is measured without scope cache.
- 42 combined notification-center cases and five current-view count cases;
  21 exact-detail/inbox presentation cases; 57 existing intent, source-runtime,
  recipient and notification compatibility cases; and 15 source/scheduler
  cases. These are serial focused partitions, not a new whole-repository gate.
- Operations TypeScript checking, generated Worker type checking, and the
  production build. The build retains its existing large-chunk warnings.
- 158 desktop/mobile browser cases across notification center, exact detail,
  staff inbox and current-view folder/file counts. Mixed-notice layouts were
  visually inspected at 375, 640, 1280 and 3440 pixels; the folder counter was
  also inspected on desktop and mobile. These use isolated fixtures, not live
  customer accounts or external logo/asset availability checks.

The first database run exposed the test harness's five-second real-D1 limit
and an older SQLite adapter missing transactional batch support. The corrected
tests use bounded real-D1 timeouts and keep prior fixture eligibility outside
later tests; the compatibility adapter now executes actual batch transactions.
No authorization assertion or migration constraint was removed to obtain a pass.

Mail transport was mocked throughout. Do not click Send Now against real
clients as a test. Remaining release gates include the paired Alpha public-ID
export approval, migration/deployment sequencing, account-level trigger capacity,
and authorized live workflow acceptance. Native upload subscriptions and group
recipient fan-out remain outside this increment, as described above.

Existing mail configuration remains SMTP. The read-only Cloudflare Email Sending
prerequisite check returned no configured sending subdomains in the selected
account; no domain was enabled and the fallback transport was not live-tested.
This does not establish a fault in the configured SMTP transport. No mail,
production migration, source activation, grant change or deployment is part of
this local implementation.
