# Project Alpha deployment-configured sources

Operations has one Project Alpha inbound destination: the existing Ops Sync
endpoint. Source authority is deployment configuration, not a browser form.
The Administration page is intentionally limited to connection status, manual
snapshot synchronization, and the separately reviewed project-creation link.
It cannot register a source, paste a credential, rotate a key, suspend a
source, or change portal authority.

## Required deployment bindings

Configure the exact same credential-free source manifest in
`PROJECT_ALPHA_CONNECTOR_SOURCES` on `ledgetop-ops` and `ledgetop-ops-sync`.
Deploy `PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS` only to Operations; it
contains snapshot API keys and optional draft-quote credentials. Deploy
`PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS` only to Ops Sync; it contains the
inbound event verification keys. Never copy either purpose secret to the other
Worker. The manifest contains only the event key ID, algorithm, and SHA-256
commitment, so both Workers can prove they refer to the same revision without
sharing credential material.

```json
{
  "version": 1,
  "sources": [
    {
      "sourceId": "project-alpha:primary",
      "producerBindingId": "ltds-project-alpha",
      "displayName": "Ledge Top Drone Services Project Alpha",
      "snapshotOrigin": "https://project-alpha.example.com",
      "applicationKey": "ltds_ops",
      "profile": "primary_legacy",
      "revision": {
        "credentialRef": "ltds_primary",
        "snapshotBasePath": "/",
        "accessIssuer": "https://example.cloudflareaccess.com",
        "accessAudience": "replace-with-Access-audience",
        "accessSubject": "replace-with-service-token-common-name",
        "eventCurrent": {
          "keyId": "ltds-current",
          "algorithm": "hmac-sha256",
          "fingerprint": "replace-with-64-lowercase-hex-sha256-commitment"
        }
      },
      "enabled": true,
      "readVisible": true
    },
    {
      "sourceId": "project-alpha:secondary",
      "producerBindingId": "ltt-project-alpha",
      "displayName": "Ledge Top Technologies Project Alpha",
      "snapshotOrigin": "https://project-alpha-secondary.example.com",
      "applicationKey": "ltds_ops",
      "profile": "business_data",
      "revision": {
        "credentialRef": "ltt_secondary",
        "snapshotBasePath": "/",
        "accessIssuer": "https://example.cloudflareaccess.com",
        "accessAudience": "replace-with-Access-audience",
        "accessSubject": "replace-with-service-token-common-name",
        "eventCurrent": {
          "keyId": "ltt-current",
          "algorithm": "ed25519",
          "fingerprint": "replace-with-64-lowercase-hex-sha256-commitment"
        }
      },
      "enabled": true,
      "readVisible": true
    }
  ]
}
```

`credentialRef` must name a set in each Worker's purpose-specific credential
secret. An Operations set contains `snapshotApiKey` and optional `draftQuote`;
an Ops Sync set contains `eventCurrent` and optional `eventPrevious`. Each
event secret must match the corresponding manifest commitment. A secondary
source requires Ed25519 event keys. The source IDs, producer IDs,
snapshot origin/path and application key are exact identities: changing one
does not repoint an existing source and fails closed.

`enabled` and `readVisible` are required for every entry; there is no permissive
default. The primary entry must be visible and must be present before any
secondary entry. It must match the
already deployed LTDS scalar destination and signing identity during the
initial upgrade. This preserves the existing `ops-sync` connection rather than
creating a portal-specific endpoint.

Compute each lowercase-hex commitment as SHA-256 over the ASCII algorithm name,
one NUL byte, and the canonical key bytes. Ed25519 uses the decoded 32-byte
base64url public key; HMAC uses the UTF-8 secret bytes. The commitment is not a
credential and cannot verify an event by itself.

## Deployment behavior

On status or snapshot resolution, Operations validates the manifest and
materializes a missing source into its durable exact-source registry. Sources
are activated or suspended only from the manifest. This is safe for a source
that has no portal authority. A portal-enabled source deliberately fails closed
if its authentication or state changes: use the paired Operations/Client portal
release to coordinate it before changing the deployment secret.

Ops Sync never materializes or changes a source. It requires its local enabled
manifest entry to match the durable source identity, revision, and event key
commitment written by Operations before accepting an event. If
`PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED=true`, a missing manifest rejects
every source. Installations that deliberately leave that guard false retain the
original scalar/registry compatibility path while upgrading. An invalid
manifest or identity mismatch never falls back to another source.

## Safe rollout

1. Add the LTDS primary snapshot set to Operations, event verifier set to Ops
   Sync, and a matching primary manifest entry to both Workers.
2. Deploy Operations and confirm the Administration page shows the primary as
   active and a manual sync succeeds.
3. Add the LTT purpose-scoped credential sets to their respective Workers and
   the same secondary manifest entry to both Workers.
   LTT uses the same Ops Sync Worker, but its signed event URL is the exact
   source-qualified route
   `/v1/project-alpha/sources/project-alpha%3Asecondary/events`; LTDS keeps its
   existing `/v1/project-alpha/events` URL. This is one integration connection
   per Project Alpha instance and one receiver service, not a portal-specific
   connection.
4. Deploy Ops Sync and Operations, confirm LTT appears as its own active exact source, then
   run a manual sync. Do not enable any portal-specific capability merely by
   adding a source.
5. Before rotating credentials for a portal-enabled source, use the paired
   portal change runbook; never paste a replacement into Operations.
