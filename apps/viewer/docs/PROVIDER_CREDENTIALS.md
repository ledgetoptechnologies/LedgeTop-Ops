# Processing provider credentials

Processing-node tokens are administered through the authenticated Viewer API. They are encrypted in SQLite with AES-256-GCM and are never returned by an API response.

## Installation key

The installation still needs one persistent encryption key outside the database:

- `PROVIDER_CREDENTIALS_KEY_ID` identifies the active key (default `provider-v1`).
- `PROVIDER_CREDENTIALS_KEY` is the active 32-byte key encoded as 64 hexadecimal characters, base64, or base64url.
- `PROVIDER_CREDENTIALS_KEYS_JSON` may contain old key IDs and values during key rotation. Keep every key referenced by an existing database row until those credentials have been saved again under the active key.

The processing platform fails configuration validation when it has no valid active key. This key is independent of the Viewer session secret and the Ops/Viewer HMAC secrets. Losing it makes stored provider credentials irrecoverable; include it in the protected configuration backup and never commit it.

Generate a hexadecimal key with `openssl rand -hex 32`. Store it in the persistent Viewer environment file with permissions limited to the container operator.

## Provider network admission

Provider endpoints remain fail-closed until an operator establishes a one-time network boundary. `PROCESSING_PROVIDER_ALLOWED_CIDRS` is a comma-separated list used only for IP-literal endpoints; for example, `192.168.50.0/24,192.168.10.0/24`. After those LANs are admitted, administrators can add and rotate processing nodes entirely through the UI. `PROCESSING_PROVIDER_ORIGINS` remains available for individually approved exact origins, including DNS origins.

Every endpoint must be a bare HTTP(S) origin. User information, paths, queries, and fragments are rejected. CIDRs never authorize DNS names. Loopback, link-local, multicast, unspecified, metadata, documentation, benchmarking, and reserved address ranges remain blocked even when a broad CIDR or exact IP origin would match. Provider HTTP redirects are rejected. When neither an exact origin nor a CIDR authorizes an endpoint, provider creation and endpoint changes fail closed.

## API lifecycle

All mutations require a Viewer admin bearer session with `viewer.providers.write` and an `Idempotency-Key` header.

Provider mutation idempotency fingerprints are keyed with a domain-separated derivative of the installation credential key. This preserves replay/conflict behavior without leaving a database-only verifier for low-entropy credential bodies.

- `POST /api/v1/processing/providers` accepts a label, bare endpoint, and optional `credential: { "token": "..." }`. The operator does not select NodeODM versus ClusterODM. Viewer probes `/info` and `/options` before storing anything, classifies a positively identified direct NodeODM 2.x API or the official ClusterODM 1.x proxy signature, and rejects malformed, unsupported, or ambiguous responses without creating a row. Creation always leaves the provider disabled.
- `PUT /api/v1/processing/providers/:id/credential` with `{ "token": "..." }` installs or rotates a credential.
- `DELETE /api/v1/processing/providers/:id/credential` removes it.
- `PATCH /api/v1/processing/providers/:id` changes metadata and enablement; it never accepts credential material.

Credential set, rotation, and removal are rejected while the provider has a nonterminal processing attempt. Each credential mutation disables the provider and clears cached health/capabilities. An endpoint change does the same. The admin must run an authenticated capability probe after the current credential and endpoint are in place, then explicitly enable the provider.

Provider DTOs expose only:

```json
{
  "credential": {
    "configured": true,
    "updatedAt": "2027-01-15T07:30:00.000Z"
  }
}
```

Tokens are accepted as exact UTF-8 strings between 1 and 4096 bytes. NUL, carriage return, and line feed characters are rejected. The implementation does not trim or normalize accepted token bytes. A successful probe with no token records an explicit private no-auth marker; that is distinct from a credential that was later cleared or cannot be decrypted, both of which continue to fail closed.

## Legacy environment map

`PROCESSING_PROVIDER_TOKENS_JSON` is a compatibility input, not the administrative source of truth. On startup, a valid legacy entry for an existing provider is encrypted into the database under the active installation key. A database credential takes precedence over the environment map. Explicitly clearing a credential writes a tombstone so a stale legacy environment entry cannot silently restore it.

After confirming migration, remove `PROCESSING_PROVIDER_TOKENS_JSON` from the environment. Provider probes, processing jobs, result ingestion, and cancellation resolve the current encrypted database credential at call time, so UI rotations do not require a container restart.
