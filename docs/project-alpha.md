# Project Alpha integration

Project Alpha is authoritative for Business Units, Projects, Project Team memberships, Operations, Tasks, assignments, and external access entitlements. This repository stores a last-known-good, read-only D1 projection.

## Deployment configuration

Choose a deployment-specific application key such as `field_operations`. Configure that same value as `APPLICATION_KEY` on both the provisioning Worker and the Operations snapshot importer, and in Project Alpha’s Custom Integrations settings. The display label, Worker names, URLs, D1 database, Access application, Access group, and application key are deployment choices.

This repository's current LTDS production deployment uses `ltds_ops`. That value is deployment configuration, not an application default: forks must choose their own key and use it consistently on all three components.

Create a dedicated Project Alpha API key with only:

```text
ops.sync.read
```

Store its plaintext value as the Operations Worker’s `PROJECT_ALPHA_API_KEY` secret. Store a separate 32-byte-or-longer `PROJECT_ALPHA_WEBHOOK_HMAC_SECRET` on the provisioning Worker and in Project Alpha. The Access service-token ID and secret belong only in Project Alpha; the Access Groups API token belongs only on the provisioning Worker.

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

Project Alpha posts signed incremental changes to `/v1/project-alpha/events`. The receiver validates Cloudflare Access, the configured application key, schema version, event ID, timestamp, and HMAC. Event receipts make delivery idempotent; per-entity source timestamps prevent older events from overwriting newer data.

A complete snapshot runs daily for recovery and reconciliation. Collection fingerprints skip unchanged projection writes. Missing rows are marked inactive only after every snapshot page succeeds, so a partial run cannot erase the last known good projection.
