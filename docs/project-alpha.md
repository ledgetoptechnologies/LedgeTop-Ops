# Project Alpha integration

## Client request pilot boundary

Project Alpha is read-only from LTDS for the client-request pilot. Staff
manually create PA projects, on-demand quotes, contracts, and invoices. LTDS
may verify and link an existing quote reference with an authenticated `GET`,
but it does not create or mutate those records and does not own financial
communications. The LTDS operational estimate is expressly non-binding; client
confirmation, final LTDS approval, and verified PA quote linkage are separate
events. See [the client request pilot contract](client-portal.md).

Project Alpha is authoritative for Business Units, Projects, Project Team memberships, Operations, Tasks, assignments, and external access entitlements. This repository stores a last-known-good, read-only D1 projection.

## Deployment configuration

Choose a deployment-specific application key such as `field_operations`. Configure that same value as `APPLICATION_KEY` on both the provisioning Worker and the Operations snapshot importer, and in Project Alpha’s Custom Integrations settings. The display label, Worker names, URLs, D1 database, Access application, Access group, and application key are deployment choices.

This repository's current LTDS production deployment uses `ltds_ops`. That value is deployment configuration, not an application default: forks must choose their own key and use it consistently on all three components.

Create a dedicated Project Alpha API key with only:

```text
ops.sync.read
```

Store its plaintext value as the Operations Worker’s `PROJECT_ALPHA_API_KEY` secret. Project Alpha signs `${timestamp}.${rawBody}` with Ed25519 and sends `X-PA-Signature-Ed25519: ed25519=<base64url signature>`. Store the base64url raw public key as `PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY`; keep the previous public key only during rotation. The legacy HMAC secret is accepted only while `PROJECT_ALPHA_ALLOW_LEGACY_HMAC=true` during rollout. The Access service-token ID and secret belong only in Project Alpha; the Access Groups API token belongs only on the provisioning Worker.

## Projection and visibility

The snapshot includes users, Business Units, worker/unit membership, clients, organizations, Business Unit-aware Projects, Project Team membership, service locations, entitlements, Operations, Operation assignments, Tasks, multi-worker Task assignments, and calendar events. It excludes passwords, authentication material, private tokens, pay rates, financial details, and secrets.

Visibility rules are assignment-driven:

- Project Team membership grants Project context.
- Direct Operation assignment grants the Operation without another Business Unit checkbox.
- Direct Task assignment grants the Task without another Business Unit checkbox.
- Project Alpha administrators receive global synchronized visibility.
- Business Unit membership is organizational metadata and does not grant Operations access.

Only explicitly enabled Project Alpha entitlements provision an Operations account. An enabled non-administrator with no Project, Operation, or Task assignment can authenticate but receives an empty operational workspace.

Projects may include `manager_user_id`. A Project Manager receives Project context in the same way as a Project Team member; Project Alpha remains responsible for making the manager a Team member and for choosing the Project's Business Unit.

Project Alpha posts signed incremental changes to `/v1/project-alpha/events`. The receiver validates Cloudflare Access, the configured application key, schema version, event ID, timestamp, and Ed25519 signature. An invalid Ed25519 signature never downgrades to HMAC. Event receipts make delivery idempotent; per-entity source timestamps prevent older events from overwriting newer data. An owner-checked, expiring D1 lease serializes same-entity events across the Operations and client/organization portal projections and the final source marker. A contending delivery receives a retryable response; it does not mutate Project Alpha or silently acknowledge an uncommitted projection.

The receiver acknowledges a valid event after its D1 projection is committed. Cloudflare Access-group membership is reconciled immediately and independently every five minutes, so a temporary Cloudflare control-plane failure cannot block Project Alpha's outbox. Configure both `CF_ACCESS_GROUP_ID` and the exact deployment-specific `CF_ACCESS_GROUP_NAME`; the name provides a safe recovery path if Cloudflare rotates or replaces the group identifier.

A complete snapshot runs daily for recovery and reconciliation. Collection fingerprints skip unchanged projection writes. Missing rows are marked inactive only after every snapshot page succeeds, so a partial fetch cannot erase the last known good projection. The snapshot fails with `delivery-db-binding-required` before fetching or committing fingerprints when the Delivery D1 binding is unavailable; it must not report a healthy reconciliation while the portal projection is stale.

Client-workspace authorization is reconciled from the current projection, not from names. A concrete active PA client controls the client account's active state; losing an optional organization alone does not suspend that account. Project grants remain valid only while the PA project is active and still belongs to the account's exact client, or, for view-only grants, its active organization. A client, organization, or project revoke/remap revokes invalid project delivery, member, and folder associations before a later account or source reactivation can revive stale access. Client-scoped folders are revoked when their concrete client account is suspended. These are LTDS-local projection and authorization changes only; LTDS never mutates Project Alpha.
