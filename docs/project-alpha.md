# Project Alpha integration

Project Alpha now exposes:

```text
GET /api/v1/ops/snapshot?page=<n>&limit=500
```

The endpoint uses Project Alpha's existing hashed API-key authentication and requires `ops.sync.read`. It returns independently paginated users, business units, worker/business-unit assignments, clients, organizations, projects, project assignments, service locations, Ops entitlements, operations, operation assignments, tasks, and normalized calendar events. Password/auth data, public project tokens, pay rates, payments, and accounting details are excluded.

Ops runs a complete snapshot every 15 minutes and provides an Owner-only manual Sync action. Records are upserted by Project Alpha ID. Missing projected rows are marked inactive only after every page succeeds; partial/failed runs never deactivate data.

Project Alpha's `ltds_ops` entitlement is the Operations login ACL. An enabled entitlement derived from the PA `admin` role grants immutable global `role-admin` access; every enabled non-admin entitlement is reduced to assignment-scoped `role-operator` access within its selected business units. A PA `owner` is not implicitly an Ops administrator. An employee entitlement with no business units can authenticate and view global airspace, but sees no PA-owned work records. Immutable Project Alpha IDs are authoritative, normalized email is used only for initial matching, and the local global Owner remains synchronization-protected.

Project Alpha sends entitlement changes to `POST https://ops-sync.ledgetopdroneservices.com/v1/project-alpha/events`. Requests must pass the dedicated Cloudflare Access Service Auth policy and include the signed `X-PA-Event-ID`, `X-PA-Timestamp`, and `X-PA-Signature` headers. Duplicate delivery is safe, and out-of-order events are ignored.

## Production key

Create a dedicated Project Alpha API key named `LTDS Ops Sync` with only:

```text
ops.sync.read
```

Store its plaintext value once as the `PROJECT_ALPHA_API_KEY` secret on `ltds-ops`. Project Alpha stores only its hash. Do not reuse a Dropbox, R2, Worker build, or administrator key.

Generate a separate random HMAC secret of at least 32 bytes. Store the same value as `PROJECT_ALPHA_WEBHOOK_HMAC_SECRET` on `ltds-ops-sync` and in Project Alpha's External Operations settings. Store the Access Service Token client ID and secret only in Project Alpha. Store `CF_ACCESS_GROUP_API_TOKEN` only on `ltds-ops-sync`; it needs Cloudflare One / Zero Trust Access Groups read and edit permissions.

The later Project Alpha Delivery resolver should use separate service authentication plus an LTDS integration key with only `folders.resolve` and, when explicitly enabled, `shares.create`. It must return review-required on ambiguous folder matches and must never create parent-level shares automatically.
