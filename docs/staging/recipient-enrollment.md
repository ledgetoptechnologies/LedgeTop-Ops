# Recipient enrollment (staging only)

This workflow lets an authorized Operations owner invite a recipient to an exact Client Portal customer/workspace selection. It is default-off, staging-only, and is not approved for production deployment or public links.

## Configuration

Keep all flags `false` unless running an approved staging validation:

- Operations: `CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED`
- Operations owner boundary: `CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ENABLED`
- Operations owner origin: `CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ORIGIN`
- Client: `CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED` (also requires the existing `CLIENT_PORTAL_ENABLED`)

The Client Worker also requires `CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET` and the private service binding `CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE`. The owner response uses the configured Client `DELIVERY_BASE_URL` when constructing the recipient destination. Do not reuse an origin, audience, CSRF secret, or service binding for another purpose.

## Routes

Owner routes are under `/api/native-client-portal/recipient-enrollment`:

- `GET /session`
- `GET /intents`
- `GET /intents/:intentId`
- `POST /intents`
- `POST /intents/:intentId/confirm`
- `POST /intents/:intentId/cancel`
- `POST /intents/:intentId/revoke`
- `POST /intents/:intentId/reconcile`

Recipient browser UI is `/portal/recipient-enrollment/:intentId#token`. The fragment keeps the opaque token out of HTTP request URLs. Its Client API is under `/api/client/v2/recipient-enrollment`:

- `GET /session`
- `POST /inspect`
- `POST /redeem`

The Operations recipient bridge is a private service binding only. It must not be mounted as a public HTTP route.

## Operator sequence

1. The owner selects and reviews the exact client record and acknowledged inactive workspace selection. Issuance returns the opaque token only once; an idempotent replay does not return it.
2. Deliver the resulting staging link through the separately approved secure channel. Never log, email-log, persist in notes, or place the opaque token in query parameters. Do not log recipient email, Access issuer, or Access subject.
3. The recipient signs in through the configured Client Cloudflare Access application. The server derives the verified issuer and subject from the signed assertion; the browser cannot supply identity fields.
4. The recipient first inspects the safe customer label and exact client/selection target, then explicitly acknowledges that same target. Inspection does not consume the intent. Redemption records the verified issuer/subject and moves the intent to owner review; it does not grant access.
5. The owner reviews the now-visible verified principal and exact target before confirming. Confirmation creates the recipient binding and queues only the existing protocol-v3 `operations.service_home.read` grant for the exact authority/workspace.
6. Treat a queued, retrying, unavailable, or uncertain dispatch as incomplete. Do not issue a replacement or manually modify D1 records merely because acknowledgement is delayed.

## Cancel and fresh issuance

An authorized owner may use `POST /intents/:intentId/cancel` only while the
intent is `issued` or `pending`. Cancellation records a terminal, immutable
marker; it does not create a recipient binding, authority command, or access.
It preserves the original token digest, target, verified principal when one was
recorded, and operation history. An `active`, `revoking`, or `revoked` intent is
not cancellable; active access must use the full revoke workflow below.

After cancellation, the old link and signed proof cannot resume enrollment.
Create a fresh intent and deliver its new one-time link through the approved
private channel. Historical issue or redeem retries for the cancelled intent
fail closed rather than returning a stale `issued` or `pending` result.

For an exact cancellation retry after an uncertain response, the server returns
the full recorded review only after rechecking the currently authenticated
owner and current authority to the exact target. A privacy-bounded minimal
receipt after target visibility has been lost is not implemented server-side;
do not weaken target authorization or add a public recovery route to work around
that limitation.

## Full revoke and reconciliation

Use `POST /intents/:intentId/revoke` for full recipient revocation. An active grant with an empty permission list is only permission removal and is not equivalent to full revoke.

Revocation moves the enrollment to `revoking`, immediately fences Operations service metadata/home reads, and queues a protocol-v3 command with `desired_state='revoked'` and empty permissions. The 0103 recipient binding remains active until the exact Client acknowledgement exists. After that acknowledgement, use the explicit `POST /intents/:intentId/reconcile`; no GET route mutates state. Reconciliation closes the exact binding and moves the enrollment to `revoked`. Never reconcile by inventing a receipt or by dispatching unrelated outbox work.

## Known gaps and acceptance limits

- A recipient proof may expire after redemption but before owner confirmation. Confirmation fails closed and creates no binding or authority outbox row. The owner may cancel that `pending` intent and issue a fresh one, but there is no proof-refresh transition and direct SQL repair remains prohibited.
- Canonical additive migration `0150_client_portal_recipient_enrollment_cancellation.sql` is applied to Ops staging after private backup and successful exact-head CI. Readback verifies 150 migrations, no pending migrations, and clean foreign keys. Ops staging recovery version is `66e5b364-16ec-4da4-a379-18982a208197`, with enrollment and authority flags still off. Local tests separately cover fresh bootstrap and representative populated issued/pending history preservation. No production application or live Cloudflare Access workflow is established by this evidence.
- On Windows, local Miniflare serial cross-D1 service-home reads can exceed the production 1.5-second transport deadline. The joined fixture freezes only timeout timers around that positive read while retaining real Client and Operations D1 queries. It therefore proves composition, not the transport deadline.
- No live staging acceptance, production approval, public-link publication, email delivery, or recipient delivery is established by the local tests.
