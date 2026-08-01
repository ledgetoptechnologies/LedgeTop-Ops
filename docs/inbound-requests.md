# Inbound file requests

## Recommended boundary

Use a separate private R2 bucket for inbound requests, not the client-delivery bucket. This prevents unreviewed contributor content from appearing in the Operations browser or being accidentally covered by a client share. The bucket should have no public domain, no Delivery Worker binding, a short lifecycle expiry, and credentials limited to the TrueNAS/Hermes pickup process.

## Request model

The Operations Worker implements this boundary on the separate public hostname `incoming.ledgetopdroneservices.com`. Exact hostname dispatch happens before staff authentication: the Incoming hostname exposes only the upload page and public/pickup routes, while the Access-protected Operations hostname exposes only staff UI and APIs. The reusable request has an opaque public id, optional hashed access code, file-count and byte quotas, contributors, and quarantined upload records. The public page is upload-only: it cannot browse, download, or enumerate requests.

Collect contributor name and email plus an optional note/reason for workflow context. Email is metadata, not authentication, and the platform does not send contributor notifications.

Protect the request form with Turnstile, per-request and per-IP rate limits, maximum outstanding files and bytes, object-name rules, and a hidden honeypot. The reusable link remains open until staff revoke or replace it. Do not place personal data in R2 object keys.

## Large uploads

Use direct multipart uploads to the private incoming bucket so the browser and R2 handle the large body without buffering it in a Worker. The Worker issues five-minute SigV4 part URLs only after validating the request, contributor session, Turnstile, and quota. Part size starts at 32 MiB and increases as needed to remain below R2's 10,000-part ceiling. D1 checkpoints and browser IndexedDB allow a contributor to reselect the same file after a reload and continue. The Worker verifies completed size and rejects basic executable/active-content signatures; TrueNAS performs authoritative checksum and ClamAV checks. Incomplete uploads expire after 24 hours.

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

## Pickup and promotion

TrueNAS/Hermes polls the quarantine prefix on its normal interval. It downloads completed objects into a central local Incoming area, verifies them, and leaves final sorting to Operations staff. Pickup should be idempotent and retain the request id/upload id in a sidecar manifest or local job log.

Delete the inbound R2 object only after local verification and successful promotion. Object disappearance alone is never treated as acceptance. After ClamAV succeeds, the SHA-256 checksum is verified, the local copy is durable, and the quarantine object is removed, call `POST /api/internal/uploads/:uploadId/accepted` with `Authorization: Bearer <INCOMING_PICKUP_SECRET>` and JSON `{ "sha256": "<64 hex characters>" }`. The Worker rejects the receipt while the quarantine object still exists. If pickup fails, leave the object for retry and alert rather than deleting it. Configure an R2 lifecycle backstop for `quarantine/` after 14 days; the Worker also aborts day-old incomplete uploads and expires completed quarantine objects after 14 days.

## Implemented boundary

The Operations Worker owns request authorization, Turnstile verification, exact quotas, multipart coordination, basic type checks, and request status. TrueNAS/Hermes owns malware scanning, checksum verification, durable local staging, and confirmation of local integrity. No inbound object is visible in Client Delivery.

An authenticated client portal flight/service request is workflow metadata, not
an upload authorization and not a payment/billing authorization. It cannot
write to R2, select an arbitrary incoming request, or bypass Turnstile,
quarantine, staff publication, project grants, or Operations staff ACLs. Any
future link from a portal request to reusable intake must be explicit,
account/project scoped, separately rate-limited, and tested in staging; it is
not part of the default-off portal foundation.
