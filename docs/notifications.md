# Client delivery and portal notifications

Operations can store an optional recipient email on a delivery share. Share creation, updates, and revocation create notification outbox records in the Delivery D1 database. Client request and request-status events use the same durable outbox. The Client Worker never sends email directly: the Operations Worker owns mail delivery.

The outbox uses unique dedupe keys. Delivery records `first_access:<share-id>` when the public session is created, so repeated sessions cannot create duplicate first-access events. Expiration notices use the share id and expiration timestamp, allowing one notice for each changed expiration.

Operations claims pending records with a short lease and retries sends at most three times with backoff. Successful and terminally failed attempts are written to the Delivery audit log; terminal failures also use the existing Operations alert path. A process crash after the provider accepts a message can still produce an at-least-once retry because email delivery has no transaction with D1.

Created and updated messages may contain the delivery link. Access codes are never included. Contributor uploads do not enqueue notifications.

Internal client-workspace folder grants use a separate outbox added by migration
`0105`; they never reuse the public-share notification contract. An optional
recipient is an exact portal identity, not an email-based authorization grant.
The row becomes eligible after five minutes, and the consumer then re-resolves
the current email only after confirming the exact immutable grant version,
active PA-backed client account, nonrevoked identity and membership, and at
least one newly visible indexed object not covered before the grant. Revocation,
narrowing, supersession, recipient deauthorization, redundant coverage, or an
empty/stale file index suppresses the row without calling the mail transport.
The action is the authenticated `/portal/deliveries` route and contains no
public share ID, token, signature, or expiry parameter.

Migration `0115` adds change subscriptions and a same-origin notification
center for authenticated client workspaces. Staff choose `off`, `added`,
`removed`, or `both` for exact active portal identities; managers are selected
by default in the Operations form. R2 create/delete events update one net-change
row per logical grant, recipient, and object fingerprint. Eligibility is reset
to five minutes after the newest event, and an opposite event during that grace
window cancels the row. The dispatcher rechecks the current immutable grant,
the authoritative Project Alpha folder owner, PA-backed active account,
identity, membership, preference, prefix coverage, and current file-index state
before either email or in-app publication. A reassigned folder therefore cannot
notify its former client even when a delayed event and stale association remain.

The portal notification list is scoped by `(account_id,recipient_identity_id)`.
Read and dismiss mutations require the authenticated portal origin and current
membership. Browser/API responses and mail contain bounded presentation text
and a same-origin portal action only—never an R2 key, absolute folder path,
public share ID/token, raw bucket URL, or recipient email snapshot. Request
status, estimate-ready, and completion messages are fanned into the same
per-identity center from the existing idempotent request outbox only while the
recipient retains the request's current account/project entitlement. Inbox
reads apply the same current-entitlement predicate, so a stored notice is no
longer visible after project access is revoked. In-app publication is committed
independently of email delivery, allowing the bell to remain the fallback when
mail is disabled or temporarily fails. Public-share delivery notifications
remain unchanged and use none of these tables or routes.
`DELIVERY_BASE_URL` on Operations must be the authenticated client portal
origin (production `client.ledgetopdroneservices.com`, or its isolated staging
equivalent), not the delivery rollback/admin host.

Client portal request and team events use the Delivery D1 outbox introduced by
migrations `0098` and `0099` and rebuilt with required request-scoped dedupe
keys and confirmation/response events by `0104`. Enqueueing is not delivery: consumers must claim
idempotently, bound retries, avoid logging client content, and retain the local
account/request authorization context. No notification recipient, Access group
membership, or Project Alpha billing contact grants portal access. Staging must
prove request-status notifications cannot cross accounts and that restoring
`CLIENT_PORTAL_ENABLED=false` does not discard pending outbox records.

## Mail transport

The current pilot uses Gmail SMTP from the Operations Worker. It connects only
to `smtp.gmail.com` on port `465` using implicit TLS; plaintext SMTP and a
STARTTLS fallback are intentionally not supported. The deployed configuration
uses these non-secret variables:

- `SMTP_NOTIFICATIONS_ENABLED=true`
- `SMTP_HOST=smtp.gmail.com`
- `SMTP_FROM` and `SMTP_USERNAME` set to the approved sender address

`SMTP_PASSWORD` is a Cloudflare Worker secret. Never place its value in source,
documentation, browser configuration, or the Client Worker. When SMTP is
enabled, an SMTP failure remains an outbox failure and is retried; the Worker
does not silently send the same message through another provider.

The existing Cloudflare Email Service binding remains an intentional fallback
only when `SMTP_NOTIFICATIONS_ENABLED=false`. This preserves one mail owner and
avoids a second application password. The Operations cron queues 72-hour
expiration notices every fifteen minutes and processes the outbox every five
minutes. Request mail uses a stable outbox-derived `Message-ID`; delivery is
still at-least-once because the provider and D1 cannot share a transaction.
For an internal folder grant, eligibility begins five minutes after creation;
the five-minute cron normally observes it roughly five to ten minutes after
creation, before provider and retry delay. This is a safety grace period, not a
five-minute delivery SLA.
The same provider boundary applies to internal folder-grant mail: revocation in
the five-minute grace window is deterministically suppressed, but a revocation
that races after the final authorization check and after SMTP has accepted the
message cannot be recalled. The exact grant is still revoked immediately, so
the authenticated portal link exposes no stale access.

Every new service request must create one `staff_triage` outbox record with a
non-null dedupe key. A blank `CLIENT_REQUEST_TRIAGE_TO` is a configuration
failure that is audited and alerted, not a successful suppression. Client
confirmation mail is separately deduped by immutable estimate version.

## Service-request presentation contract

Each service-request outbox row stores a versioned, nonfinancial presentation
snapshot in its existing `payload_json`; this contract requires no database
migration. Version 1 contains only the human-readable request title,
existing-project or `New or one-off service` context, service scope/category,
stable location label, lifecycle presentation value, and portal action. New
events render from that immutable snapshot so retries, later request edits, or
project-name changes cannot alter the message. The consumer rebuilds only these
same bounded fields from the request-scoped database join when processing a
legacy pre-versioned row.

Location labels follow the client request record: an explicitly selected
geocoder address/place is preferred; otherwise the stored reverse-geocoded
nearby road/place is used; otherwise bounded coordinates render as
`Near <latitude>, <longitude>`; a request with neither uses `Location not
specified`. The notification consumer does not perform geocoding or invent an
exact address.

Client-facing subjects use `Service request` and human lifecycle labels. They
never expose the internal request type or database status tokens. Existing
projects are named plainly; account-level work is always described as `New or
one-off service`. Staff submission and client-response mail links to the
request's LTDS Operations review route. Client status and estimate-ready mail
links to the authenticated client request overview.

The presentation snapshot and renderer intentionally exclude request details,
site contacts, notification-recipient metadata, billing contacts, estimate
amounts, currency, Project Alpha identifiers, quote/document numbers,
contracts, and invoices. Financial artifacts remain under Project Alpha's
authority. In particular, linking a verified Project Alpha quote can update the
service-request lifecycle, but no quote field is copied into the notification
payload or message.

## Pilot verification

For a controlled portal request, verify all of the following: the request is
visible in the Operations triage queue, its outbox record reaches `sent`, and
the approved recipient receives the notification. Do not use a real client
request as the first transport test, and do not treat email delivery as a grant
of portal access.

For an internal folder grant, use a synthetic client workspace and indexed test
object. Verify a revoke inside the grace window leaves the outbox `suppressed`,
the portal returns no file, and the mail mock records zero sends. For the valid
case, advance only the controlled outbox clock, verify exactly one call with a
stable message ID and `/portal/deliveries`, then repeat the consumer to prove it
does not send again. Never use an actual client address for this test.
