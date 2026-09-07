# Client feedback: contract and rollout

Status: implemented and verified locally, August 26, 2026. Not
published, migrated in production, or live-accepted. This document describes the
bounded feedback increment of the [client workspace roadmap](client-workspace-roadmap.md),
not completion of the whole roadmap.

## Workflow and scope

A signed-in client selects **Leave Feedback** on an authorized project, project
folder, or individual delivery file, writes a message, and submits. The client
does not need to categorize the problem or create a service request. Feedback
does not confer resource access and is independent of `request.create`.

Operations exposes a dedicated feedback queue and detail view. Authorized staff
can move a report from New to In Progress to Done, or directly from New to Done
for an acknowledgement. Completion may include a note. Done is terminal in this
increment; reopening, threaded replies, and editing a completed response are not
implemented policies.

The report keeps its exact canonical target and author identity. It does not
duplicate the photo, video, or folder contents. A replacement file at the same
path is not the original target. When the original is missing or replaced, an
otherwise authorized author can still read their feedback history, but the
original target is marked unavailable and no replacement or broader folder is
opened as a fallback.

The initial report pins the indexed file version **at submission**. Existing
browser handles identify a path, not the version of a possibly cached earlier
preview. Replacement during authorization/write is fenced, but replacement
before submission preflight is not an optimistic conflict with that old preview.
An opaque preview-version precondition is a separate follow-on before claiming
version-bound annotations or before/after review. Do not describe this increment
as preserving the version a person happened to view earlier.

This increment does not implement feedback inside the Viewer, model annotations,
website-element selectors, video timestamps, attachments, or anonymous public
links. The Viewer and thumbnail runtimes remain unchanged.

### Native Project Alpha extension

Migration `0184_native_client_feedback.sql` adds the separate native-workspace
ownership and lifecycle records. It does not reinterpret migration `0155`
primary feedback or create a legacy account bridge. Migration
`0188_native_feedback_completion_notices.sql` adds creator-only in-app
completion notices without adding an email outbox. Native feedback stays
unavailable until the exact source is present in the default-empty,
deploy-managed `CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS` stopgap and its
current workspace/principal authority, target readiness, and schema checks all
pass. This allowlist is not a grant and will be replaced by independently
signed source capability evidence. Primary feedback availability is not a
fallback. See
[native portal requests and feedback](native-portal-requests-feedback.md).

## Authorization invariants

- Client history and notifications are creator-only, not visible to every member
  of the same account or folder. Verified issuer/subject, account or selected
  workspace, and the original identity bridge must match. Email similarity is
  never identity or authorization.
- Every read, submission, continuation, notification action, and mail attempt
  rechecks current eligibility and resource authorization. Current explicit
  denies, expiration, source ownership, and workspace state take precedence.
- A missing file does not waive account, workspace, project, association, or
  ownership checks. Revocation or reassignment must not transfer old feedback to
  the next owner or allow the previous owner to open new content.
- Staff require existing `operations.manage` authority in the current division,
  plus the applicable project assignment/visibility and delivery permission.
  Directory visibility, share-audit permission, and a contact role are not write
  authority. No new grant is created by feedback.
- Staff may acknowledge history after its author leaves only while the original
  account/workspace association and current source authority remain valid. A
  native workspace whose sole account bridge was revoked is not authorized by
  the historical bridge. Acknowledgement never reactivates the author or makes
  them eligible for a completion email.
- New submissions require a mapped Project Alpha client or organization, and a
  mapped Project Alpha project for project-scoped targets. Structurally unmapped
  targets return a configuration-unavailable response before any write. This
  readiness check is not an Operations permission grant or proof of an active
  source in the separate Operations database.
- Staff project ownership follows the existing explicit portal project-grant
  contract: a current exact source-client match or an explicitly mapped source
  organization match. Business-directory grouping does not redefine that grant;
  a client-mapped account can validly omit its client's organization ID.
- Workspace hints in URLs select an already authorized workspace; they cannot
  authorize it. The UI must establish that selection before fetching a target.
- Public DTOs omit storage keys, internal ownership proofs, principal claims,
  grants, and encrypted cursor contents. Deep links are locators, not bearer
  grants, and resolve through the normal authenticated application.

Delivery-side authorization proofs participate in the first database mutation,
not only a preflight read. Operations policy lives in a separate database; it is
rechecked around the mutation. There is no cross-database atomic transaction,
and a response must not claim there is one. Writes and changes to a proof for a
returned item fail closed. Client lists omit candidates that are no longer
authorized and can return an empty page with a continuation; that page does not
assert that no older feedback exists.

## Durable records and retry behavior

Delivery migration `0155_client_feedback.sql` adds feedback, immutable lifecycle
events, staff mutation receipts, private completion notices, and a dedicated mail
outbox. It does not rewrite existing accounts, grants, requests, or mail records.

- Creation, the initial event, and audit entry are one database batch.
- Staff updates use an expected revision and an idempotency key. Status, receipt,
  event, audit, and (for Done) notice/outbox writes commit together.
- A replay with the same actor, scope, key, and payload reuses the original
  transition receipt after current authorization checks. Staff responses include
  that receipt's applied revision and the current authorized record, which may
  reflect a later transition. A changed payload with the same key conflicts.
  Concurrent updates cannot silently overwrite each other.
- An uncertain browser retry retains the same key. A deliberately new report
  uses a new key. A canceled browser request is not proof the server did not
  commit; the UI must not claim otherwise.
- History remains after media removal. Existing account-retention constraints
  remain in force; this migration is not an account-erasure workflow.

Completion creates an in-app notice independently of email availability. Email
uses the existing configured transport and a generic authenticated feedback link;
it contains no client message, completion note, filename, or storage path.
Disabled mail is explicitly suppressed, not recorded as delivered. Dispatch is
bounded and lease-fenced, with at most three attempts and a frozen message
fingerprint. A changed recipient/context is suppressed instead of sending a
different message during an uncertain retry.

The database ensures one completion notice and outbox record. External mail is
at-least-once: losing a provider acknowledgement can duplicate the same message.
Neither a stable message ID nor an idempotent database receipt proves exactly-once
delivery by an external provider.

## API boundaries

- Client session capability `feedback` reports schema readiness under the existing
  authenticated portal gate; it is not a content-access grant.
- Client list/create/detail routes live under `/api/client/feedback`; private
  completion notices use `/api/client/feedback-notifications`.
- Native list/create/detail routes remain exact-workspace v2 routes. Native
  completion notices use
  `/api/client/v2/workspaces/:workspaceId/feedback-notifications[/:id]`, join the
  completed submission on its exact source/workspace/creator/principal tuple,
  and reauthorize the original recipient live before list or mutation. They do
  not send email; native feedback email remains pending.
- Exact file metadata can resolve a deep link without scanning the first page of
  a folder. It is authorized like the underlying file and does not return bytes.
  Missing feedback-routing mappings do not block an otherwise authorized file
  preview; the submission-readiness check is separate from resource-read access.
- Staff list/detail routes are `/api/operations/feedback[/:id]`. The only status
  mutation is `POST /api/operations/feedback/:id/status` with `Idempotency-Key`,
  `expectedRevision`, `status`, and nullable `note`.
- Operations session capability `clientFeedback.enabled` exposes the entry point
  for an existing management grant once the schema is ready. It does not change
  the employee permission list or authorize any queue row or status update.
- Staff see the exact target label and project context, with independently
  checked availability. Staff target `actionPath` remains null in this increment:
  the Operations file browser does not yet provide an exact-file deep link.
  Do not label every target missing, fabricate Client Portal handles, or open a
  broader folder as if it were the original file. Client completion links do
  resolve the exact original target when it is still authorized and available.
- Lists are bounded and cursor-paged. Staff encrypted cursors bind the actor,
  filters, and staff permission policy. Client position cursors bind the list
  kind and exact actor/account/workspace context; they are not permission
  snapshots. Both paths reauthorize each resource live, and neither cursor is
  permission to return hidden rows.
- Staff pages inspect at most 50 candidates and return at most 25 authorized
  matches. A page with no visible matches can still have a continuation; the UI
  must offer it instead of claiming the entire history is empty.
- Feedback bodies are bounded plain text. Server errors and audit metadata must
  not expose the body, credentials, ownership proofs, or private paths.

## Local verification evidence

The full Client backend gate passes **566 tests across 52 files**, zero failures
or skips, in **546.96 seconds**. This includes 23 feedback target/route tests and
21 real-D1 store tests. The earlier focused store run passed in 22.35 seconds.
The fixture applies the actual preceding migration chain to
populated data and then `0155`. Coverage includes duplicate and concurrent
submissions, scope-separated replay, guard revocation, competing staff updates,
creation and completion rollback on audit/outbox failure, immutable history,
file-index deletion, bounded input, foreign keys, and indexed lookups. All-status,
client-account, and client/status queue pages use ordered indexes rather than
sorting the entire feedback table, including continued pages.

The complete Client browser gate passes **172 tests**, with four intentional
mobile-project duplicates skipped because the desktop visual cases explicitly
exercise 375, 640, 1280, and 3440-pixel widths (176 collected; zero failures;
3.6 minutes). The Client type check and production build pass. Independent
visual review confirmed composer, detail, and exact-file preview layouts. Browser
QA corrected cramped navigation and control spacing, retained workspace hints
through Back/Forward, and fenced stale notification responses. Browser fixtures
do not establish deployed authorization or live mail delivery.

The complete Operations browser gate passes **410 tests**, zero failures or
skips, in **4.1 minutes**; its type check and production build also pass. Visual
review covered the same four widths, including queue search and completion
forms. The first full run had four failures from two fixture issues across both
browser profiles: the new named folder count made an old unscoped status locator
ambiguous, and a map test clicked the WebGL canvas before its point layer loaded.
The corrected tests select the actual notice and wait for real mapped-point hover
readiness before clicking. The 14-case focused rerun and final full suite pass
without changing the map runtime or weakening unavailable-image assertions.

The full Operations backend gate passes **905 tests across 114 files**, zero
failures or skips, in **1131.85 seconds**. It includes all 20 staff feedback
authorization/lifecycle cases and 10 completion-dispatch cases. Together, the
two applications pass **1,471 backend tests and 582 browser tests**, with four
intentional duplicate-viewport browser skips, and both type checks/builds.

The completed local gates cover:

- Legacy and native workspace routes, exact identity/owner changes,
  denies/expiry, missing/replaced targets, forged/cross-scope cursors, ambiguous
  associations, and authority changes immediately before writes.
- Assigned/division-scoped staff and no-permission actors, source moves,
  status replay/conflicts, and the exact mutation authentication boundary.
- Mail-disabled/suppressed, concurrent/reclaimed leases, frozen retry
  payloads, recipient revocation, and a lost provider acknowledgement without
  sending real client mail.
- Complete Client and Operations types/builds and integrated backend suites.
- Composer cancel/retry, detail refresh and Back/Forward, notification
  links beyond a folder's first page, workspace switching, empty/error states,
  keyboard operation, long text, and mobile/laptop/ultrawide layouts.

These results are application-package gates, not a full-monorepo or production
acceptance claim. The separately known pre-existing root thumbnail-runbook
assertion was not changed or included in these package gates. Live authorization,
deployment, and provider mail delivery remain unverified in this increment.

## Rollout and recovery

Do not apply a production migration or publish images from this document alone.
This branch also contains earlier unpublished directory, project-workspace,
notification, and service-request slices with separate prerequisites. Review the
whole release range and their runbooks before deployment. The outstanding Alpha
public-ID prerequisite and its publication approval remain separate.

After approval and acceptance, back up the Delivery database and apply its
ordered additive migrations, including `0184` before the paired compatible
Client/Operations code, `0188` before native feedback is enabled, and `0200`
before Operations exposes exact-workspace native feedback history, while
`CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS` remains empty.
Readiness must show unavailable when the feedback schema is absent, while the
existing application remains usable. Use a designated test account for the
post-deploy smoke test; do not create client invitations, grants, or email as a
side effect of testing.

For a code rollback, first clear `CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS`,
confirm capability readback, and drain staff transitions and completion leases.
Retain the additive tables and audit history. Do not drop
feedback or replay receipts to clear an error, reset sent outbox records, or
rewrite authorization snapshots. Reconcile pending notices before resuming a
dispatcher. A successful local run is not evidence that a deployed browser or
mail provider has been verified.

## Exact-client lifecycle history

The Client Hub can lazily read redacted lifecycle metadata for project, folder,
and file feedback owned by the exact selected business workspace. Primary and
native sources use source-qualified indexed queries and encrypted, actor-bound
continuation cursors with an immutable as-of row watermark. Every candidate is
re-authorized and the client mapping, policy, and context are checked again
before release. The list response deliberately excludes feedback messages,
completion notes, actor details, storage keys, and authorization proofs; staff
must open the existing feedback review route to read permitted content.

The signed-in client receives the same deliberately redacted lifecycle shape
for only feedback they created in the exact current source, workspace, and
root. Its AES-GCM continuation cursor is bound to the Access issuer/subject and
scope, carries a fixed as-of row watermark, and expires after 15 minutes.
Every row is re-authorized before release. Message bodies and completion notes
remain available only through the separately authorized feedback detail route.
This read-only surface creates no sharing, membership, notification, or mail
side effect and uses the existing primary and native feedback author indexes;
no additional migration is required.
