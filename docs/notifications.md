# Client delivery notifications

Operations can store an optional recipient email on a delivery share. Share creation, updates, and revocation create notification outbox records in the Delivery D1 database. The Operations Worker sends those records through the Cloudflare Email Service binding; the Delivery Worker never sends email directly.

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

Configure and verify the `delivery@ledgetopdroneservices.com` Email Service sender before deployment. The Operations cron queues 72-hour expiration notices and processes the outbox every fifteen minutes.
