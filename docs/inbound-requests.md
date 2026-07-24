# Inbound file requests

## Recommended boundary

Use a separate private R2 bucket for inbound requests, not the client-delivery bucket. This prevents unreviewed contributor content from appearing in the Operations browser or being accidentally covered by a client share. The bucket should have no public domain, no Delivery Worker binding, a short lifecycle expiry, and credentials limited to the TrueNAS/Hermes pickup process.

## Request model

The `apps/incoming` Worker implements this boundary. Each request has an opaque public id, optional hashed access code, intake label, creator, expiry, file-count and byte quotas, contributors, and quarantined upload records. The public page is upload-only: it cannot browse, download, or enumerate other requests.

Collect contributor name and email plus an optional note/reason for workflow context. Email is metadata, not authentication, and the platform does not send contributor notifications.

Protect the request form with Turnstile, per-request and per-IP rate limits, an expiry, a maximum number of files, maximum total bytes, object-name rules, and a hidden honeypot. Do not place personal data in R2 object keys.

## Large uploads

Use direct multipart uploads to the private incoming bucket so the browser and R2 handle the large body without buffering it in a Worker. The Worker issues five-minute SigV4 part URLs only after validating the request, contributor session, Turnstile, and quota. Browser parts are 32 MiB. The Worker verifies the completed object size and rejects basic executable/active-content signatures; TrueNAS performs the authoritative checksum and ClamAV checks. Incomplete multipart uploads expire after 24 hours.

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

Provision `TURNSTILE_SECRET`, `INCOMING_SESSION_SECRET`, `INCOMING_ACCESS_CODE_PEPPER`, `AUDIT_IP_SECRET`, `R2_INCOMING_ACCESS_KEY_ID`, and `R2_INCOMING_SECRET_ACCESS_KEY` as Worker secrets. Register separate staging and production Turnstile widgets and set `TURNSTILE_SITE_KEY` in the matching environment.

## Pickup and promotion

TrueNAS/Hermes polls the request prefix on its normal interval. It downloads only completed, clean, checksum-verified objects into a local quarantine/staging area, then moves accepted files into the operator-selected `Jobs/Clients/<client-or-organization>/...` destination. The promotion should be idempotent and retain the request id/upload id in a sidecar manifest or local job log.

Delete the inbound R2 object only after local verification and successful promotion. Object disappearance alone is never treated as acceptance. After ClamAV succeeds, the SHA-256 checksum is verified, the local copy is durable, and the quarantine object is removed, call `POST /api/internal/uploads/:uploadId/accepted` with `Authorization: Bearer <INCOMING_PICKUP_SECRET>` and JSON `{ "sha256": "<64 hex characters>" }`. The Worker rejects the receipt while the quarantine object still exists. If pickup fails, leave the object for retry and alert rather than deleting it. Configure an R2 lifecycle backstop for `quarantine/` after 14 days; the Worker also aborts day-old incomplete uploads and expires completed quarantine objects after 14 days.

## Implemented boundary

The Worker owns request authorization, Turnstile verification, exact quotas, multipart coordination, basic type checks, and request status. TrueNAS/Hermes owns malware scanning, checksum verification, durable local staging, promotion into `Jobs/Clients/<client-or-organization>/...`, and confirmation of local integrity. No inbound request object is eligible for a client Delivery share until promotion is complete.
