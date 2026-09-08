# Inbound file requests

## Recommended boundary

Use a separate private R2 bucket for inbound requests, not the client-delivery bucket. This prevents unreviewed contributor content from appearing in the Operations browser or being accidentally covered by a client share. The bucket should have no public domain, no Delivery Worker binding, a short lifecycle expiry, and credentials limited to the TrueNAS/Hermes pickup process.

## Request model

The Operations Worker implements this boundary on the separate public hostname `incoming.ledgetopdroneservices.com`. Exact hostname dispatch happens before staff authentication: the Incoming hostname exposes only the upload page and public/pickup routes, while the Access-protected Operations hostname exposes only staff UI and APIs. The reusable request has an opaque public id, optional hashed access code, file-count and byte quotas, contributors, and quarantined upload records. The public page is upload-only: it cannot browse, download, or enumerate requests.

Collect contributor name and email plus an optional note/reason for workflow context. Email is metadata, not authentication, and the platform does not send contributor notifications.

Protect the request form with Turnstile, per-request and per-IP rate limits, maximum outstanding files and bytes, object-name rules, and a hidden honeypot. The reusable link remains open until staff revoke or replace it. Do not place personal data in R2 object keys.

## Large uploads

Use direct multipart uploads to the private incoming bucket so the browser and R2 handle the large body without buffering it in a Worker. The Worker issues five-minute SigV4 part URLs only after validating the request, contributor session, Turnstile, and quota. Every ticket signs the exact expected `Content-Length` and declared `Content-Type` for one upload object and part; the browser must use those values, and an oversized or cross-part PUT cannot reuse the capability. Part size starts at 32 MiB and increases as needed to remain below R2's 10,000-part ceiling. D1 checkpoints and browser IndexedDB allow a contributor to reselect the same file after a reload and continue. Resume requires a SHA-256 fingerprint over stable metadata plus bounded first/last samples, so another file with the same name, size, MIME type, and timestamp cannot inherit checkpoints. Signed URLs are never persisted. The browser uses direct XHR-to-R2 transfer for within-part byte progress, obtains a fresh five-minute ticket for each bounded retry, and sends no source bytes to the Worker. A contributor may cancel only their own in-progress upload; cancellation aborts the private multipart upload, clears checkpoints, and releases reserved quota exactly once. The Worker verifies completed size and rejects basic executable/active-content signatures; TrueNAS performs authoritative checksum and ClamAV checks. Incomplete uploads expire after 24 hours.

The bucket must allow CORS only from `https://incoming.ledgetopdroneservices.com`:

```json
{
  "rules": [
    {
      "allowed": {
        "origins": ["https://incoming.ledgetopdroneservices.com"],
        "methods": ["PUT"],
        "headers": ["content-type"]
      },
      "exposeHeaders": ["etag"],
      "maxAgeSeconds": 300
    }
  ]
}
```

Provision `TURNSTILE_SECRET`, `INCOMING_SESSION_SECRET`, `INCOMING_ACCESS_CODE_PEPPER`, `AUDIT_IP_SECRET`, and `INCOMING_PICKUP_SECRET` on `ltds-ops`. The Operations `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` credential is scoped to object read/write on `client-data` and `ltds-incoming`; the signer hardcodes the Incoming bucket. Register separate staging and production Turnstile widgets and set `TURNSTILE_SITE_KEY` in the matching environment.

Apply Delivery migrations `0116_incoming_upload_hardening.sql`, `0198_incoming_upload_owner_notifications.sql`, and `0199_incoming_upload_pickup_lifecycle.sql` before deploying the dependent Worker. The first adds the resume fingerprint and a rolling-deploy-safe trigger for exactly-once quota release; the second adds the owner-notification outbox without changing existing upload status; the third adds the Operations-owned pickup lifecycle plus an opaque, leased server claim. Neither migration grants access. `/health` fails closed with HTTP 503 and lists only missing configuration names when the D1/R2/Turnstile/signer/Workflow prerequisites are incomplete. Do not enable or advertise incoming uploads from an unhealthy environment.

The Operations Incoming uploads workspace exposes the request title, maximum file count, and maximum total bytes already enforced by the server. Editing these settings never reduces a limit below currently reserved usage.

Each first successful transition from `uploading` to `quarantined` records one idempotent digest item in the same Delivery D1 transaction. Items for the same request and contributor roll into one pending digest generation and restart a two-minute quiet window, so a multi-file upload produces one owner email with the contributor display name, new-file count, total new bytes, request title, and explicit pending-verification state. A digest becomes immutable when sending starts: files completed during a send, retry, or after delivery create or join the next generation, so no completion is lost and retry content does not change beneath a stable `Message-ID`.

The five-minute Operations notification drain resolves the captured `file_requests.created_by` staff ID against the active directory in `OPS_DB` and emails only that request owner; contributor email is never a notification recipient. Digests and messages contain no object key, signed upload capability, token, secret, or contributor email. Each version has a deterministic outbox-derived `Message-ID`, a ten-minute lease, and at most three transport attempts. An inactive or missing owner is suppressed without falling back to another recipient, and a later upload starts a new digest version.

## Pickup and promotion

Only the repository-owned TrueNAS/Hermes pickup worker polls the private
`quarantine/` prefix on its normal interval. A generic R2 mirror, Cloud Sync
task, rclone job, or Windows copy job must exclude that whole prefix: copying
it creates an opaque `quarantine/.../object` tree locally and bypasses the
scan/receipt lifecycle. The pickup worker downloads completed objects into a
central local Incoming area, verifies them, and promotes them under its
request-id/upload-id/payload/original-name hierarchy, with `receipt.json`
beside the fixed `payload/` directory. Pickup must be idempotent and
retain the request id/upload id in a sidecar manifest or local job log.

Claim a quarantined object first with `POST /api/internal/uploads/:uploadId/pickup-status`, `Authorization: Bearer <INCOMING_PICKUP_SECRET>`, and JSON `{ "state": "scanning", "claimToken": "<uuid>" }`. The Worker atomically accepts only an awaiting, due-retry, or expired-lease claim, returning the same claim token and a short lease expiry. Persist that token privately. Renew active work before lease expiry with `{ "state": "heartbeat", "claimToken": "<uuid>" }`; retry with `{ "state": "retry", "claimToken": "<uuid>", "retryAfterSeconds": 60, "errorCode": "safe_category" }`. Never put raw scanner/transport errors in this API.

Delete the inbound R2 object only after local verification and successful promotion. Object disappearance alone is never treated as acceptance. After ClamAV succeeds, the SHA-256 checksum is verified, the local copy is durable, and the quarantine object is removed, call `POST /api/internal/uploads/:uploadId/accepted` with `Authorization: Bearer <INCOMING_PICKUP_SECRET>` and JSON `{ "sha256": "<64 hex characters>", "claimToken": "<uuid>" }`. The Worker rejects the receipt while the quarantine object still exists and also rejects a different claim. It accepts the exact persisted claim after lease expiry only for the narrow crash-recovery case where durable local promotion and R2 deletion already occurred before the receipt; a live worker must renew its lease and must not delete after losing it. If pickup fails, leave the object for retry and alert rather than deleting it. Configure an R2 lifecycle backstop for `quarantine/` after 14 days; the Worker also aborts day-old incomplete uploads and expires completed quarantine objects after 14 days.

## Implemented boundary

The Operations Worker owns request authorization, Turnstile verification, exact quotas, multipart coordination, basic type checks, and request status. TrueNAS/Hermes owns malware scanning, checksum verification, durable local staging, and confirmation of local integrity. No inbound object is visible in Client Delivery.

An authenticated client portal flight/service request is workflow metadata, not
an upload authorization and not a payment/billing authorization. It cannot
write to R2, select an arbitrary incoming request, or bypass Turnstile,
quarantine, staff publication, project grants, or Operations staff ACLs. Any
future link from a portal request to reusable intake must be explicit,
account/project scoped, separately rate-limited, and tested in staging; it is
not part of the default-off portal foundation.
