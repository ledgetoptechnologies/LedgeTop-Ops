# Architecture and security boundaries

## Request boundaries

```text
Cloudflare Access
      |
      v
ops.ledgetopdroneservices.com
      |-- OPS_DB: staff, ACL, projects, operations, tasks, FAA, audit
      |-- DELIVERY_DB: share administration and file index
      |-- private R2: staff browsing
      `-- Queue/Stream management

delivery.ledgetopdroneservices.com
      |-- DELIVERY_DB only
      |-- private R2, prefix-confined per share
      |-- Images thumbnails
      `-- Stream signed playback only
```

Delivery never receives an `OPS_DB` binding. R2 has no public bucket domain. Both Workers stream object bodies and HTTP byte ranges rather than buffering media.

## Staff authentication and ACL

Cloudflare Access authenticates people; it does not grant LTDS permissions. The Ops Worker verifies the Access JWT signature, issuer, expiry, exact Operations audience, `RS256`, `type=app`, nonempty human subject, and email. The email must match an active provisioned account. On first successful login, that account binds to the Access subject and rejects future subject mismatches.

ACL order:

1. Missing, inactive, unprovisioned, or subject-mismatched staff are denied.
2. Resource division, owner, and assignment context is derived server-side.
3. Applicable explicit user denies override all grants.
4. Explicit user allows and role grants are evaluated by scope.
5. Missing permission denies by default.
6. Module denials return `403`; inaccessible cross-division objects return `404`.
7. Lists apply SQL scope predicates before pagination.

The Owner role is represented by immutable seeded grants; code has no role-name bypass. The API prevents deactivation of the final active global Owner.

## Client link security

New URLs have the form:

```text
https://delivery.ledgetopdroneservices.com/s/<public-id>#<32-byte-secret>
```

The fragment is never transmitted in an HTTP request. The browser posts it once, receives a signed `__Host-ltds_delivery` `HttpOnly; Secure; SameSite=Lax; Path=/` cookie, and removes the fragment from browser history. D1 stores only SHA-256 of the secret. Legacy `/s/<secret>` links are upgraded on redemption and remain compatible.

Optional access codes are PBKDF2-derived with a random salt, application pepper, bounded iteration count, and rate limiting by share/client and client across shares. A session cannot outlive its share. Every manifest, preview, and download rechecks revocation and expiration.

R2 paths use opaque base64url item references. Validation rejects traversal, backslashes, controls, absolute paths, `dump` components, and the reserved `_ltds` root. Unsafe formats such as HTML, XML, JavaScript, and SVG are downloads rather than inline content.

## Airspace safety model

TFRs and special-use airspace are deliberately separate:

- TFRs can restrict or prohibit operations.
- MOAs are nonregulatory but may contain hazardous military activity.
- Restricted/prohibited areas retain their regulatory type.
- A missing SUA reservation is `not_listed`, never inactive or clear.

FAA data is checked every two hours and is stale after three hours without a complete successful refresh. Stable source and record fingerprints prevent unchanged snapshots from rewriting D1; only changed or missing records are reconciled. Failed parses retain the last known snapshot. Expired/withdrawn TFR and expired SUA reservation rows are purged after 24 hours; stable SUA geometry remains for future matching. The UI never displays “clear to fly.”
