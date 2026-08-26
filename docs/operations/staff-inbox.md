# Staff inbox: needs attention

Status: implemented and locally verified; not published or migrated.

## Workflow and coverage

Open the bell in the Operations header or Operations → Inbox. The refresh-safe
route is `/operations/inbox`; search is stored in `?q=`. Each source is an
independent queue, with its own loading, empty, unavailable, retry and continuation
state. A failed section is not an empty queue. Shown counts are loaded rows, not
an unread count, an exact total, or a merged chronology.

| Queue | Order and next action | Authority |
| --- | --- | --- |
| Client requests | Oldest submitted, under-review or awaiting-Alpha-linkage requests first; open the exact request in Client Hub | Current global `operations.manage`, including explicit denies; active account |
| Client feedback | Oldest new/in-progress feedback first; open exact feedback details | Existing current feedback scope, project visibility, assignment and delivery rules; explicit session readiness |
| Pending delivery notices | Newest pending/processing legacy-folder batches first; open the exact notification, even if it has since completed | Existing current exact-grant and division-scoped `delivery.share.audit`; mutation permissions remain separate |
| Connection failures | Reported `error` health for active Project Alpha connectors and the legacy primary; open connection administration | Administrator plus global `integrations.manage`; UI additionally requires `administration.view` so its action is navigable |

The inbox does not send email, retry processing, dismiss work, grant access, or
interpret viewing as acknowledgement. Existing workflow pages own their actions
and recheck current authorization. Notification deep links use `batchId`, not
account names or the position of a batch in a paginated list. Terminal batches
remain readable when their current history scope is still authorized; missing
or inaccessible batches expose no stale action buttons.

Connection health uses the existing bounded connector registry. `stale`,
`disabled`, suspended, pending and retired connectors are not silently treated as
reported synchronization errors. No raw provider exception or credential is
rendered in the inbox.

## Data and authorization

`GET /api/operations/inbox/requests` is a narrow, read-only summary endpoint.
It searches title, client/account and project before a 25-row keyset page limit.
It preserves the existing global staff request-triage contract across local,
primary and secondary records; portal eligibility is not substituted for staff
permission. It does not return quotes, prices, contact details, request contents,
storage paths or source identifiers. Current staff identity and global scope are
checked before and after data hydration. The bounded page is rechecked against
current account/status/ownership facts before release.

Request cursors are encrypted and bound to actor, normalized query and current
scope, expire after 30 minutes, and cannot be reused for a different query or
principal. Replay of an unchanged page is safe. Search is literal substring
matching: SQLite ASCII case folding plus exact NFC Unicode matching, not a claim
of full Unicode case folding or fuzzy search.

The feedback reader adds `status=open` as a read filter only. It means `new` or
`in_progress`; no feedback mutation accepts `open` as a lifecycle state. Existing
feedback and delivery readers retain their independently authorized scans and
cursors. An empty scanned page with a continuation still offers Load more.

`GET /api/notifications/deliveries/:id` reads the exact notification and rechecks
its current resource, eligibility and policy before returning the existing DTO.
Send Now and Cancel continue to use the existing revision/idempotency workflow.
There is no new mail dispatch mechanism or notification audience.

The browser cancels obsolete loads and uses independent 20-second deadlines.
Search, refresh and unmount discard old responses. Permission/context errors
clear the affected queue and its continuation; a 401 clears the entire inbox and
asks for sign-in. A temporary continuation failure retains previously loaded
rows with an explicit not-refreshed label and retries the same page. Payload
validation rejects malformed records rather than displaying them as an empty
queue. There is no cross-user browser cache.

## Rollout and remaining requirements

No migration, binding, environment variable, Viewer change or thumbnail change
is introduced by this increment. Release it together with the preceding local
feedback, notification-batch and source-provenance migrations; it is not a
compatibility shortcut around those contracts. In particular, request summary
reads rely on the existing catalog/account/project source columns. Missing
schema or services must remain visibly unavailable.

This is progress toward the handoff's unified staff inbox, not completion of
that requirement or of the overall Client Workspace goal. Outstanding sources:
native-workspace and other notification outboxes, access changes, collaborator
addition/expiry, uploads and processing completion/failure. Personal/shared
acknowledgement and dismissal, ownership/assignment, durable event retention and
an authoritative unread count need their own explicit contracts. The separate
five-minute notification grace workflow and recipient policy are unchanged.

Before publishing, verify the paired schema/application release, real authorized
source mappings, role-scoped pages and each deep-linked workflow in the target
environment. No production customer access, messages or migration was exercised
to validate this local increment.

## Verification record

Local verification on August 26, 2026:

- Operations TypeScript and production build passed.
- 33 presentation and route cases passed; all 11 real-D1 request inbox cases
  passed, including more than 200 requests, policy changes and cursor replay.
- 144 desktop/mobile browser cases passed across the staff inbox, exact notice
  links, existing notification workflows and responsive navigation. Visual
  inspection caught and corrected narrow-header overflow; keyboard, history,
  cancellation and access-revocation cases are included.
- 44 combined backend cases passed for the open-feedback filter, exact
  notification reads, and existing notification authorization/control workflows.
  The existing feedback lifecycle suite also passed all 21 cases. A final
  TypeScript check passed after the test-fixture corrections.

The notification cursor regression now verifies authenticated encryption of the
hidden scan boundary rather than assuming ciphertext cannot randomly contain a
two-character substring. The feedback read-filter fixture bulk-seeds valid rows
from one actual submission; separate existing lifecycle tests still exercise
creation, mutation, audit and notification writes.

Synthetic browser fixtures prove UI behavior; separate real-D1/Hono tests prove
data filtering and authorization, not a live production login. No production
deployment, migration, email or client-access change was part of these checks.
