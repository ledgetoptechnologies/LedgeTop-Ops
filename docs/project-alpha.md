# Project Alpha integration

Project Alpha now exposes:

```text
GET /api/v1/ops/snapshot?page=<n>&limit=500
```

The endpoint uses Project Alpha's existing hashed API-key authentication and requires `ops.sync.read`. It returns independently paginated users, business units, worker/business-unit assignments, clients, organizations, projects, project assignments, and service locations. Password/auth data, public project tokens, pay rates, invoices, payments, and accounting data are excluded.

Ops runs a complete snapshot every 15 minutes and provides an Owner-only manual Sync action. Records are upserted by Project Alpha ID. Missing projected rows are marked inactive only after every page succeeds; partial/failed runs never deactivate data.

Email matching may link a projected Project Alpha user ID to an already provisioned Ops staff account, but it never creates a staff account or grants a permission. Access allowlisting and Ops ACL provisioning remain deliberate, separate steps.

## Production key

Create a dedicated Project Alpha API key named `LTDS Ops Sync` with only:

```text
ops.sync.read
```

Store its plaintext value once as the `PROJECT_ALPHA_API_KEY` secret on `ltds-ops`. Project Alpha stores only its hash. Do not reuse a Dropbox, R2, Worker build, or administrator key.

The later Project Alpha Delivery resolver should use separate service authentication plus an LTDS integration key with only `folders.resolve` and, when explicitly enabled, `shares.create`. It must return review-required on ambiguous folder matches and must never create parent-level shares automatically.
