# Client delivery and portal notifications

Operations can store an optional recipient email on a delivery share. Share creation, updates, and revocation create notification outbox records in the Delivery D1 database. Client request and request-status events use the same durable outbox. The Client Worker never sends email directly: the Operations Worker owns mail delivery.

The outbox uses unique dedupe keys. Delivery records `first_access:<share-id>` when the public session is created, so repeated sessions cannot create duplicate first-access events. Expiration notices use the share id and expiration timestamp, allowing one notice for each changed expiration.

Operations claims pending records with a short lease and retries sends at most three times with backoff. Successful and terminally failed attempts are written to the Delivery audit log; terminal failures also use the existing Operations alert path. A process crash after the provider accepts a message can still produce an at-least-once retry because email delivery has no transaction with D1.

Created and updated messages may contain the delivery link. Access codes are never included. Contributor uploads do not enqueue notifications.

Client portal request and team events use the Delivery D1 outbox introduced by
migrations `0098` and `0099`. Enqueueing is not delivery: consumers must claim
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
expiration notices and processes the outbox every fifteen minutes.

## Pilot verification

For a controlled portal request, verify all of the following: the request is
visible in the Operations triage queue, its outbox record reaches `sent`, and
the approved recipient receives the notification. Do not use a real client
request as the first transport test, and do not treat email delivery as a grant
of portal access.
