# Client business activity and recent ordering

Status: locally implemented and verified, August 26, 2026. Not deployed.
This document describes a bounded business-projection increment, not a complete
activity feed or a production deployment.

## Scope and meaning

The increment records source-owned changes to Alpha organizations, clients and
projects. Client Hub can use independently authorized observations to order
customers by recent business activity, with an explicit name-order alternative.
Both primary and secondary business sources retain their exact ownership.

An applied business event and a snapshot observation are different evidence.
Snapshot observations are labelled as a record update, not as proof that someone
performed a particular action. Only a valid business timestamp from the source
payload may describe when that record was updated. Sync completion, local row
`updated_at`, indexing time, delivery receipt time and page-view time must not be
presented as business activity. Missing or invalid business timestamps remain
unknown; they must not become "just now".

Actor attribution is not supplied by this slice. A transport credential, event sender, receipt
actor field, customer contact or matching email is not a verified human actor.
Do not invent a person's name when the producer contract supplies no trustworthy
actor identity.

This slice does not infer quote, contract, invoice, payment, email, service
subscription or delivery activity. It does not record routine deployments as
customer activity or send clients notifications. Existing feedback, delivery
notices and request history keep their separate authorization and lifecycle.

## Ownership before aggregation

An activity observation belongs to a source-qualified record and its captured
business owner. Reading it must prove both the original owner and the record's
current ownership. Moving a project or contact to another customer must not
transfer the former customer's history or expose the new customer's changes to
the former owner.

The reader also requires the source record to remain currently readable.
Revocation observations can be retained in the immutable ledger without being
displayed after the corresponding record becomes inactive or disappears. This
is not a permanent, universally accessible customer audit log.

Source visibility, active-root checks and the existing project permission and
assignment rules apply before computing a maximum timestamp, count or sort key.
An unauthorized project must not affect even the ordering of an otherwise
visible customer. Business-party linking remains presentation-only: it neither
authorizes an activity nor combines staff or portal grants.

For a readable linked customer, recent ordering must aggregate its authorized
contributors before applying the customer page limit. Search can determine
which customer matches; it must not silently redefine that customer's activity
to mean only the matching source record. Likewise, an explicit source filter
selects customers with a matching source; the displayed update time still
covers all independently authorized linked business records. In
`grouping=records` mode, each source card uses only its own activity. If the
whole party is no longer
readable, existing directory rules return independently readable source cards
without exposing a hidden party label, member count or aggregate activity.

## Writes, replay and pagination

Only an actually applied projection event may append its corresponding activity
in the same Operations transaction as the projected record. Exact retries and
stale or rejected events must not create another observation or advance recent
ordering. Snapshot observations must be idempotent and accurately labelled;
re-reading unchanged data is not new activity.

The ledger separately retains normalized `source_updated_at` for deduplication.
For a snapshot observation this is the valid payload `updated_at`; for an
applied event it is the signed projection's source-update timestamp, distinct
from the event's `occurred_at`. Read-model matching requires the same source,
record kind, record ID, normalized source-update timestamp and captured owner.
An old-owner event that is no longer readable cannot suppress a separately
captured current-owner observation. It is not a customer-name, email or
cross-source match. When both kinds of evidence describe that same
version, the ledger can retain one immutable snapshot observation and the
explicit projection-event evidence. The read model prefers an eligible explicit
event rather than displaying the same-version observation as another change.
Until that event's occurrence time reaches the page's `asOf` cutoff, the dated
snapshot observation can remain visible. Neither arrival order rewrites or
deletes previously retained evidence.

A repeated event ID is an exact no-op only when its stored record, action,
occurrence and source-update timestamp match; conflicting reuse must not
overwrite the immutable ledger. An Operations record/activity transaction can
succeed before a separate Delivery reconciliation fails. The pending event
remains retryable without appending another activity on that retry. Displayed
business activity is therefore not proof of successful Delivery reconciliation,
mail delivery or completion of another system's workflow.

Timestamp normalization must preserve real instants, including valid timezone
offsets. The established Alpha timezone-less SQL timestamps mean UTC; fractional
seconds are normalized consistently to millisecond precision. Invalid calendar
dates and malformed zone/fraction strings are rejected, not repaired into a
different date. Unknown times sort after known activity, with deterministic name and
source-qualified identity tie-breakers. Directory cursors bind the requested
sort, search, filters, grouping, policy and relevant revisions. A change that can
alter authorized ordering requires a refresh rather than silently skipping or
duplicating customers across pages. These checks do not claim an immutable
snapshot across separate databases.

## API surface

The directory accepts `sort=recent|name`, defaulting to recent business updates.
Its response distinguishes `activityAsOf` from `indexUpdatedAt` and identifies
the limited activity coverage. A customer with no authorized dated observation
has an unknown update time, not the directory's last refresh time.

`GET /api/client-hub/sources/:sourceId/business/:kind/:publicId/activity`
returns source-record activity for one independently authorized business root.
The kind segment is `organizations` or `standalone`. Optional `projectId`
selects an exact authorized business project. `limit` is bounded to 1–100
(initial route default 5); continuation uses an opaque cursor and can include
the shared `expectedContextVersion`. The response contains the canonical root,
current context, bounded items, page metadata, `asOf` and the explicit
`source_records_only` coverage marker. No source payload, transport actor or
financial details are returned.

Malformed or cross-resource cursors are rejected. Changed context or activity
requires refresh; hidden sources and unavailable roots do not return stale
items as a fallback. Responses are not cached, and every page retains live
authorization checks. The migration is
`0037_client_business_activity.sql`; its writer and reader changes must be
released together under the existing coordinated deployment gates.

## Required local acceptance

- Apply the real additive migration to populated primary/source fixtures and
  preserve existing IDs, payloads, receipts and directory relationships.
- Same record and event IDs in two sources remain independent; retry, stale
  version and rollback leave no duplicate or orphan activity.
- Missing, malformed and timezone-offset timestamps cannot turn sync time into
  activity or reverse chronological order.
- Owner moves, source hiding, project permission removal and assignment changes
  cannot influence another customer's timestamp, count or recent position.
- Group before limiting; test a party whose newest activity belongs to its
  non-representative source, including search matching only its older member.
- Verify recent/name sorting, stable ties, unknown times, stale cursors, empty
  states, refresh and Back/Forward on narrow and desktop layouts.

Use synthetic local data. Verification must not send mail, mutate production
customers, activate another connector or touch Viewer/thumbnail runtimes.

## Local verification checkpoint

The following completed against this increment, with one heavy runtime at a time:

- Operations activity store/migration and actual HTTP routes: **32/32** tests.
- Operations directory, snapshot and connector-sync regressions: **75/75** tests.
- A final fresh-primary post-read authority check: **3/3** targeted race tests;
  these repeat three directory cases, rather than adding three unique tests.
- Full ops-sync package: **64/64** tests across five files, including five new
  real producer/rollback/snapshot cases. Expected rejection logs in negative
  authentication tests are not runtime failures.
- Operations and ops-sync TypeScript checks: passed.
- Operations production build and ops-sync Wrangler dry-run build: passed.
  The existing client chunk-size warning remains; it was not hidden or treated
  as a passing performance audit.
- Operations browser gate: **242/242** desktop/mobile cases across activity,
  directory, linked customers, business project workspaces, independently paged
  details, scoped link history, current-view item counts and responsive navigation.
- Inspected generated directory and history screenshots at mobile and desktop
  sizes, plus the direct-folder count screenshot. Automated layout checks also
  covered 640px and 3440px widths, long names, focus and overflow.

The browser gate uses the built application with synthetic API responses; the
HTTP and database suites separately exercise real local D1 schemas and Worker
routes. These checks do not constitute live paired-system acceptance. No
production customer, permission, migration, mail, Viewer or thumbnail change
was performed. Cloudflare/Workers guidance informed same-batch event capture,
bounded reads and fresh-primary authorization rechecks. The established
coordinated migration/release gates still apply, including Operations migration
0037 before readers/writers that require its ledger. Retain additive schema on
application rollback; do not erase immutable evidence to roll back a UI.

## Separate service-capability prerequisite

Recent activity is not evidence of which services a customer receives. The
current Alpha catalog exports globally requestable service IDs, versions,
categories, questions and geometry rules. Categories are presentation labels;
the contract does not project per-customer service assignments or a
service-to-portal-feature mapping. Existing login eligibility and explicit
resource entitlements remain distinct from catalog visibility.

True service-driven portal functionality needs an authoritative, versioned
assignment contract with an exact source/customer or project, stable service
family, lifecycle and effective dates. Before enforcement, decide whether
ending a service changes presentation or revokes historical access, and whether
customers may request offerings they do not already receive. Do not infer these
decisions from invoices, customer names, source names or linked-party membership.

A safe independent UI increment can report current workspace feature readiness
using existing grants, denies and deployment support, without calling it a
purchased-service assignment. Preserve authorized history when creation is
unavailable, and preserve project-only access when root-level permission is
absent. Every action must still authorize its current exact target.

Secondary catalog/portal activation requires its own authenticated connector
capability and current source proof; the business-data registry profile alone
does not confer portal authority. Alpha publication remains separately
approval-blocked. Do not retry it or enable a second live source as part of this
activity increment. See [the client workspace roadmap](client-workspace-roadmap.md),
[service request readiness](client-service-request-readiness.md),
[source isolation](multi-source-client-design.md) and
[business-party linking](business-party-linking.md).
