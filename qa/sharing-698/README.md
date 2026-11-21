# QA fixture for #698 (not for merge)

This is a source-only handoff for staging QA of the sharing composition in #698. It doesn't change any product code. Don't merge it.

Codex's QA owns the private launcher, signer custody, the runtime and staff admission. This folder supplies only:
- the inputs;
- a disposable seed;
- an ephemeral test signer;
- the expected results.

Folder-aware sharing (#655, #657, #688) is out of scope.

## Pins

| Input | Pin |
|---|---|
| Product commit (#698 head) | `9931fc34bd2e8acd2b40b4c6aa0a99e3c0dbf3ec` |
| Product tree | `bf8ccfe5c0f0c3586bb231e4127a2deceb0708d3` |
| Fixture branch | `claude/sharing-698-qa-fixture`, based on the product commit. It adds only `qa/sharing-698/**` and `apps/operations/test/qa-sharing-698-contract.test.ts`, so `git diff 9931fc34 -- . ':!qa' ':!apps/operations/test/qa-sharing-698-contract.test.ts'` is empty. |
| Client D1 schema (`DELIVERY_DB`, `apps/client/migrations`) | 161 files, last `0242_client_ops_triage_inquiries.sql` |
| Ops D1 schema (`OPS_DB`, `apps/operations/migrations`) | 236 files, last `0244_staff_operations_access_writer.sql` |
| Viewer schema (`apps/viewer/server/database.js`) | 83 (`provider_engine_processing_elapsed`) |

Build the product from the product commit (or this branch, whose product files are identical). Use Node 24, the version the fixture was checked with.

| App | Commands (from the repository root) |
|---|---|
| Client | `cd apps/client && npm ci && npm run check && npm run build` |
| Ops | `cd apps/operations && npm ci && npm run check && npm run build` (Ops typechecks against `../client`, so install Client first) |
| Viewer | `cd apps/viewer && npm ci && npm run build` |

## Disposable databases

Use two new, empty D1 databases, one for each binding. Never use an existing staging or production database.

1. **DELIVERY_DB** (Client and Ops both bind it): apply every migration in `apps/client/migrations` in filename order, then `seed-delivery.sql`.
2. **OPS_DB**: apply every migration in `apps/operations/migrations` in filename order, then `seed-ops.sql`.

The seeds only insert rows. They never change the schema.

What the seeds create (all names invented, all mail on `example.test`):

- **Workspace `qa698-workspace-alpha`**: standalone client "Alpha Survey Co (QA)".
  - Principal `clientAlpha` (`qa698-subject-alpha`, alpha.client@example.test) can view and has delivery and directory access.
  - One delegation over 4 folder targets and 3 delegated shares, so `limit=2` gives two pages of each list kind.
- **Workspace `qa698-workspace-bravo`**: organization "Bravo Land Group (QA)".
  - Principal `clientBravo` (`qa698-subject-bravo`, bravo.client@example.test).
- **`clientAlphaColleague`** (`qa698-subject-alpha-colleague`): may view both workspaces but holds no delegation. It is used only to show that list cursors are bound to the caller and the workspace.
- **Staff** (OPS_DB), all with role `qa698-role-viewer-manager` (viewer.view and viewer.manage):
  - `staffManager` (`qa698-staff-manager`): global role. Allowed.
  - `staffDenied` (`qa698-staff-denied`): global role plus a global deny override on viewer.manage. Denied.
  - `staffDivision` (`qa698-staff-division`): the role at division scope only. Denied, because global authority is required.
- **Source authority**: a private-ingress pin `pa_portal_primary_private_authority('project-alpha:primary','qa698-portal-app')`. Both workspaces are unclaimed native workspaces read through it.
- **No Viewer direct grants.** The contract creates and revokes the one grant itself.

## Signing: test-only, ephemeral keys

`ephemeral-access.mjs` makes a fresh RS256 key pair in memory on every run. The private key is never exported or written.

```
node qa/sharing-698/ephemeral-access.mjs --out <directory outside the repository>
```

This writes two files and prints nothing. It refuses a directory inside the repository.
- `jwks.json`: the public key only.
- `assertions.json`: 15-minute Access-style assertions for every principal in `contract.json`.

The products verify the assertions with their existing verifiers. Client uses `resolveCloudflareClientPrincipal` (jose `jwtVerify`, RS256, issuer, audience and exp). Ops uses its staff Access verifier.

The QA launcher must serve `jwks.json` at `<issuer>/cdn-cgi/access/certs` for both issuers (or point the verifier at it), and send each assertion as `Cf-Access-Jwt-Assertion`. No persistent key, real account or hosted signer is involved.

| Setting | Value |
|---|---|
| Client `CLIENT_ACCESS_TEAM_DOMAIN` / `CLIENT_ACCESS_AUD` | `https://clients-access.example.test` / `qa698-client-portal-aud` |
| Ops `TEAM_DOMAIN` / `OPERATIONS_AUD` | `https://staff-access.example.test` / `qa698-operations-aud` |

## Runtime configuration the contract assumes

Values are invented. Secrets are generated fresh by the launcher and never committed.

| App | Variables |
|---|---|
| Client | `CLIENT_PORTAL_ENABLED=true`<br>`CLIENT_PORTAL_ORIGIN=https://portal.example.test`<br>`CLIENT_PORTAL_HIERARCHY_V2_ENABLED=true`<br>`CLIENT_VIEWER_ENABLED=true`<br>`PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED=false`<br>`PROJECT_ALPHA_PORTAL_APPLICATION_KEY=qa698-portal-app`<br>`DELIVERY_SESSION_SECRET` (32+ random characters)<br>`VIEWER_SESSION_ISSUER` service binding → Ops |
| Ops | `VIEWER_INTEGRATION_ENABLED=true`<br>`CLIENT_VIEWER_SESSION_ISSUER_ENABLED=true`<br>`CLIENT_PORTAL_HIERARCHY_V2_ENABLED=true`<br>`APPLICATION_KEY=qa698-portal-app`<br>`VIEWER_SERVICE_HMAC_SECRET` (32+ random characters)<br>the Viewer service binding |
| Flags left unset (off) | `CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED`<br>`CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED`<br>`AUTHENTICATED_DELIVERY_GRANTS_ENABLED`<br>`CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED` |

## Prerequisites owned by Codex QA

1. A private launcher that starts Ops, Client and Viewer from the pins above against the two disposable databases, plus custody of the ephemeral JWKS and assertions.
2. **Staff admission and login bindings** for the three staff rows, so that their Access assertions resolve to those staff ids. The seed provides only the staff rows and their ACL.
3. **A Viewer instance** that has published project `qa698-viewer-project` ("Boundary survey (QA)") with one task `qa698-task-0001` ("Boundary survey model (QA)"), and that accepts session creation and source-authorization revocation from Ops.
4. **Isolation:** no live shares and no real clients, staff or keys. Tear everything down after the run.

## Contract

The expected results are in `contract.json` and the table below, which is generated from that file. Run the cases in order: later cases reuse saved values (`${grantId}`, cursors). Ops cases are sent to the Ops origin with the staff assertion, and client cases to `https://portal.example.test` with the client assertion and a same-origin `Origin` header.

Contents of `${projectGrant}`: `qa698-workspace-alpha`, `qa698-viewer-project`, whole project, future tasks included, measure only, no expiry.

The cases cover:
- **Paging branches:**
  - the named picker cursor (P);
  - the legacy no-`include` picker (L), which keeps the bare-id cursor and no `rootType`;
  - the staff grant listing (G, A3);
  - the client delegated-share pages of both list kinds, shares (S) and targets (T).
- **Cursor binding** (B): a delegated-share cursor works only for the same list kind, the same caller and the same workspace. A foreign cursor is a 400. A caller who may not open the workspace gets 404 before the cursor is read.
- **Legacy no-cursor** (N): a request without a cursor or limit returns the first page of up to 100 rows.

| ID | Area | Actor | Request | Expected |
|---|---|---|---|---|
| D1 | recipient discovery | staffManager | `GET /api/viewer/direct-client-grants?include=clients` | 200; clients: 2; clients.0.workspaceId = "qa698-workspace-alpha"; clients.1.workspaceId = "qa698-workspace-bravo"; clientsNextCursor = null |
| D2 | recipient discovery | staffManager | `GET /api/viewer/direct-client-grants?include=clients&q=alpha.client%40` | 200; clients: 1; clients.0.workspaceId = "qa698-workspace-alpha"; clients.0.rootType = "standalone_client"; no clients.0.email |
| D3 | recipient discovery | staffDenied | `GET /api/viewer/direct-client-grants?include=clients` | 403; code = "forbidden" |
| D4 | recipient discovery | staffDivision | `GET /api/viewer/direct-client-grants?include=clients` | 403; code = "forbidden" |
| P1 | picker paging (named cursor) | staffManager | `GET /api/viewer/direct-client-grants?include=clients&limit=1` | 200; clients: 1; clients.0.workspaceId = "qa698-workspace-alpha"; clientsNextCursor ~ /^v1\./ |
| P2 | picker paging (named cursor) | staffManager | `GET /api/viewer/direct-client-grants?include=clients&limit=1&cursor=${pickerCursor}` | 200; clients: 1; clients.0.workspaceId = "qa698-workspace-bravo"; clientsNextCursor = null |
| P3 | picker paging (named cursor) | staffManager | `GET /api/viewer/direct-client-grants?limit=1&cursor=${pickerCursor}` | 400 |
| L1 | legacy no-include picker | staffManager | `GET /api/viewer/direct-client-grants?limit=1` | 200; clients: 1; grants: 0; clients.0.workspaceId = "qa698-workspace-alpha"; clientsNextCursor = "qa698-workspace-alpha"; grantsNextCursor = null; no clients.0.rootType |
| C1 | create | staffDenied | `POST /api/viewer/direct-client-grants`<br>Idempotency-Key qa698-create-denied-0001, body projectGrant | 403; code = "forbidden" |
| C2 | create | staffManager | `POST /api/viewer/direct-client-grants`<br>Idempotency-Key qa698-create-alpha-0001, body projectGrant | 201; replayed = false; grant.workspaceId = "qa698-workspace-alpha"; grant.scopeType = "project"; grant.grantVersion = 1 |
| C3 | create | staffManager | `POST /api/viewer/direct-client-grants`<br>Idempotency-Key qa698-create-alpha-0001, body projectGrant | 200; replayed = true; grant.grantId = "${grantId}" |
| C4 | create | staffManager | `POST /api/viewer/direct-client-grants`<br>Idempotency-Key qa698-create-alpha-0002, body projectGrant | 409; code = "duplicate_active_grant"; grantId = "${grantId}" |
| G1 | grant listing (paged) | staffManager | `GET /api/viewer/direct-client-grants?include=grants&viewerProjectId=qa698-viewer-project` | 200; grants: 1; clients: 0; grants.0.grantId = "${grantId}"; grantsNextCursor = null |
| R1 | signed read | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/viewer` | 200; items: 1; items.0.grantId = "${grantId}"; items.0.taskId = "qa698-task-0001"; items.0.workspaceId = "qa698-workspace-alpha"; nextCursor = null |
| R2 | signed read | clientAlpha | `POST /api/client/v2/workspaces/qa698-workspace-alpha/viewer/${grantId}/tasks/qa698-task-0001/session`<br>Idempotency-Key qa698-session-alpha-0001, body {"displayUnits":"imperial"} | 201; modelId = "qa698-model-0001" |
| R3 | wrong identity | clientBravo | `GET /api/client/v2/workspaces/qa698-workspace-alpha/viewer` | 404 |
| R4 | wrong workspace | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-bravo/viewer` | 404 |
| R5 | wrong identity | clientBravo | `POST /api/client/v2/workspaces/qa698-workspace-alpha/viewer/${grantId}/tasks/qa698-task-0001/session`<br>Idempotency-Key qa698-session-bravo-0001, body {"displayUnits":"imperial"} | 404 |
| R6 | signed read | clientBravo | `GET /api/client/v2/workspaces/qa698-workspace-bravo/viewer` | 200; items: 0; nextCursor = null |
| R7 | unsigned | (no assertion) | `GET /api/client/v2/workspaces/qa698-workspace-alpha/viewer` | 401 |
| R8 | forged signature | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/viewer`<br>assertion signed by an unknown key | 401 |
| V1 | revoke | staffDenied | `DELETE /api/viewer/direct-client-grants/${grantId}`<br>Idempotency-Key qa698-revoke-denied-0001, body {"reason":"QA denied revoke"} | 403; code = "forbidden" |
| V2 | revoke | staffManager | `DELETE /api/viewer/direct-client-grants/${grantId}`<br>Idempotency-Key qa698-revoke-alpha-0001, body {"reason":"QA revoke"} | 200; success = true; replayed = false; sessionRevocation.pending = false |
| V3 | revoke | staffManager | `DELETE /api/viewer/direct-client-grants/${grantId}`<br>Idempotency-Key qa698-revoke-alpha-0001, body {"reason":"QA revoke"} | 200; success = true; replayed = true |
| A1 | read after revoke | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/viewer` | 200; items: 0; nextCursor = null |
| A2 | read after revoke | clientAlpha | `POST /api/client/v2/workspaces/qa698-workspace-alpha/viewer/${grantId}/tasks/qa698-task-0001/session`<br>Idempotency-Key qa698-session-alpha-0002, body {"displayUnits":"imperial"} | 404 |
| A3 | read after revoke | staffManager | `GET /api/viewer/direct-client-grants?include=grants&viewerProjectId=qa698-viewer-project` | 200; grants: 0; grantsNextCursor = null |
| S1 | share paging (kind=shares) | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-shares?limit=2` | 200; shares: 2; shares.0.id = "qa698-share-alpha-0001"; shares.1.id = "qa698-share-alpha-0002"; nextCursor ~ /^ds2\./ |
| S2 | share paging (kind=shares) | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-shares?limit=2&cursor=${sharesCursor}` | 200; shares: 1; shares.0.id = "qa698-share-alpha-0003"; nextCursor = null |
| T1 | share paging (kind=targets) | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-share-targets?limit=2` | 200; targets: 2; targets.0.folderTargetId = "qa698-target-0000-root"; targets.1.folderTargetId = "qa698-target-0001-phase"; nextCursor ~ /^ds2\./ |
| T2 | share paging (kind=targets) | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-share-targets?limit=2&cursor=${targetsCursor}` | 200; targets: 2; targets.0.folderTargetId = "qa698-target-0002-phase"; targets.1.folderTargetId = "qa698-target-0003-phase"; nextCursor = null |
| B1 | cursor binding: list kind | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-share-targets?limit=2&cursor=${sharesCursor}` | 400 |
| B2 | cursor binding: list kind | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-shares?limit=2&cursor=${targetsCursor}` | 400 |
| B3 | cursor binding: caller | clientAlphaColleague | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-shares?limit=2&cursor=${sharesCursor}` | 400 |
| B4 | cursor binding: workspace | clientAlphaColleague | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-shares?limit=2` | 200; shares: 0; nextCursor ~ /^ds2\./ |
| B5 | cursor binding: workspace | clientAlphaColleague | `GET /api/client/v2/workspaces/qa698-workspace-bravo/delegated-shares?limit=2&cursor=${colleagueCursor}` | 400 |
| B6 | cursor binding: wrong identity | clientBravo | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-shares?limit=2&cursor=${sharesCursor}` | 404 |
| B7 | share paging limits | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-shares?limit=101` | 400 |
| N1 | legacy no-cursor | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-shares` | 200; shares: 3; nextCursor = null |
| N2 | legacy no-cursor | clientAlpha | `GET /api/client/v2/workspaces/qa698-workspace-alpha/delegated-share-targets` | 200; targets: 4; nextCursor = null |

## Validation done for this handoff (local, light runs)

- **Seed check:** `node qa/sharing-698/fixture-db.mjs` builds both databases in in-memory SQLite (node:sqlite; every migration, then the seed). Then it checks:
  - `foreign_key_check` and `integrity_check` pass;
  - the seed counts match `contract.json`;
  - every address in the seeds is on example.test;
  - the digests below match.
- **Contract run:** `cd apps/operations && npx vitest run --config vitest.config.ts test/qa-sharing-698-contract.test.ts` runs every case above against the real Ops routes (`registerDirectViewerClientRoutes`), the real Client router (`createClientPortalRouter`) and the real issuer, over the same seeded in-memory databases.
  - Client assertions are minted per run by `ephemeral-access.mjs` and verified by the real Client verifier.
  - Only the external Viewer service is a test double.
  - Staff principals are injected after Access, because staff admission is the launcher's (prerequisite 2).
- **Existing unit tests:** run on the product commit; see the PR for results.

## Digests

SHA-256, with line endings normalised to LF. `README.md` is hashed with its own digest replaced by `<self>`. Check them with `node qa/sharing-698/fixture-db.mjs` (validates) or `--digests` (prints).

| File | SHA-256 |
|---|---|
| `README.md` | `4814a9cc0add98cb658b5c0e1fcc64eea9241a966c387d59a7b397bb3b091e10` |
| `contract.json` | `ef24fdc21ce9cf7904f0cd4dcc750e5088fb69aaab5b128eb65c56ec3c429c8b` |
| `seed-delivery.sql` | `565325a31dfc9fb2f7a3b64147da18466cbae06e38e3dd7da29ff86ffd7eb7da` |
| `seed-ops.sql` | `2bdeb7c2a02a71dc80827f934f709a095dbdbf5b9d861533905e9cc967651e01` |
| `d1-sqlite.mjs` | `7d1b3fe633f0cf995f64fd7a3d13353766472ee30e235e732a1ba2ec2c121229` |
| `fixture-db.mjs` | `7bb891e659db5928257d4fcd637dd36b742d1d8b4733adf91b72dbf6e006a212` |
| `fixture-db.d.mts` | `33a1f94e4821f981e40e8985089fa52973be9e4e287c6cef3fae7bf6d4f61e79` |
| `ephemeral-access.mjs` | `8cd5515696f63e3852d725df66f16113efb44501ab8d8c50c2ae83c84933b2e8` |
| `ephemeral-access.d.mts` | `85a7e709f85badcfe43b5ee26f6312c3f73d201b5fceb90d5a9d09d2752c1026` |
| `../../apps/operations/test/qa-sharing-698-contract.test.ts` | `6ae5311ed3894394d92282d1609381dfa99c123030c51a3c32ed9cdb81fbd354` |
