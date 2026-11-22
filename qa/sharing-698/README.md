# QA fixture for #698 (not for merge)

This is a source-only handoff for staging QA of the sharing composition in #698. It doesn't change any product code. Don't merge it.

Codex's QA owns the private launcher, signer custody, the runtime and staff admission. This folder supplies only:
- the inputs;
- a disposable seed for Ops and Client;
- a disposable schema-83 Viewer catalog and asset seed, with a closed storage manifest and an offline readback;
- an in-process ephemeral test signer;
- the expected results.

Folder-aware sharing (#655, #657, #688) is out of scope.

## Pins

| Input | Pin |
|---|---|
| Product commit (#698 head) | `9931fc34eec0e69172dae907ee9be0848dbf9c53` |
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

## Synthetic identifiers: one UUID per entity

Every synthetic entity has exactly one UUID, registered in `contract.json` under `"entities"` and listed at the end of this README. The same UUID is used for that entity in the seed SQL, the contract, this README and the signer inputs:
- **A client principal's** identity id is also its Access `sub`.
- **A staff member's** id is also its bound Access subject.
- **A workspace's** tuple is its workspace id, its source root public id and its directory generation id.

`fixture-db.mjs` fails if any of these hold:
- a UUID appears that isn't registered;
- a registered UUID is never used;
- two entities share a UUID;
- a signer input differs from the entity's UUID;
- a seeded row binds a different UUID.

Non-entity values keep readable names: version strings (`qa698-member-v1` …), idempotency keys, configuration keys and audiences, and placeholder hashes.

## Disposable databases

Use two new, empty D1 databases, one for each binding. Never use an existing staging or production database.

1. **DELIVERY_DB** (Client and Ops both bind it): apply every migration in `apps/client/migrations` in filename order, then `seed-delivery.sql`.
2. **OPS_DB**: apply every migration in `apps/operations/migrations` in filename order, then `seed-ops.sql`.

The seeds only insert rows. They never change the schema.

What the seeds create (all names invented, all mail on `example.test`):

- **Workspace `workspace.alpha`**: standalone client "Alpha Survey Co (QA)".
  - Principal `clientAlpha` (entity `client.alpha`, alpha.client@example.test) can view and has delivery and directory access.
  - One delegation over 4 folder targets and 3 delegated shares, so `limit=2` gives two pages of each list kind.
- **Workspace `workspace.bravo`**: organization "Bravo Land Group (QA)".
  - Principal `clientBravo` (entity `client.bravo`, bravo.client@example.test).
- **`clientAlphaColleague`** (entity `client.colleague`): may view both workspaces but holds no delegation. It is used only to show that list cursors are bound to the caller and the workspace.
- **Staff** (OPS_DB). See the authorization model below.
- **Source authority**: a private-ingress pin `pa_portal_primary_private_authority('project-alpha:primary','qa698-portal-app')`. Both workspaces are unclaimed native workspaces read through it.
- **No Viewer direct grants.** The contract creates and revokes the one grant itself.

## Viewer side (schema 83)

A third disposable database: a fresh Viewer SQLite file, built by the Viewer's own migrations (`apps/viewer/server/database.js`, head 83 `provider_engine_processing_elapsed`), then `seed-viewer.sql`. Mount `viewer-storage/models/` as the Viewer's `models` storage root. The seed adds rows only, and the Viewer schema is unchanged.

`seed-viewer.sql` publishes one task, using the four registered Viewer UUIDs plus five more Viewer-side entities:

| Entity | Row |
|---|---|
| `viewer.project` | `projects`: active, "Boundary survey (QA)" |
| `viewer.task` | `processing_tasks`: published, `published_model_id` = `viewer.model`, `active_attempt_id` = `viewer.attempt` |
| `viewer.model` | `models`: provider `ltds-processing`, `provider_model_id` = `viewer.task`, ready, `active_version_id` = `viewer.modelVersion` |
| `viewer.modelVersion` | `model_versions`: ready, `provider_version_id` = `viewer.attempt`. Also `model_outputs.id`: published, managed v2 layout `<task>/<attempt>.v2` under root `models`. |
| `viewer.attempt` | `processing_attempts`: published, result = the model and version, dataset = `viewer.dataset` |
| `viewer.dataset` | `datasets`: finalized, managed, no files |
| `viewer.provider` | `processing_providers`: `nodeodm`, disabled, `https://nodeodm.example.test` |
| `viewer.asset.glb` | `model_assets`: kind `glb`, published, hash-pinned; its file is `viewer-storage/models/<task>/<attempt>.v2/source/odm_texturing/odm_textured_model_geo.glb` |
| `viewer.audit.publish` | `audit_events`: `processing_attempt.published` by `staff.admin` |

`seed-viewer.sql` comes in two parts:
- **Part 1** is the ready-for-review state the Viewer's ingest leaves.
- **Part 2** is exactly the writes of `ProcessingRepository.publishAttemptInTransaction(attempt, ['glb'])`, in its order.

The readback replays Part 1 through the real function and requires the same rows.

**`viewer-manifest.json` is closed:**
- every file under `viewer-storage/` (path, storage root, relative path, bytes, SHA-256, owning asset);
- `seed-viewer.sql` and `viewer-readback.mjs` (bytes and SHA-256 after LF normalisation).

The readback fails on any extra, missing or changed file.

**Offline readback:** `node qa/sharing-698/viewer-readback.mjs` (after `npm ci` in `apps/viewer`). It uses an in-memory database, the Viewer's own repository code, and no listener, network or Viewer runtime. It checks:
- schema 83 and the seed;
- the manifest and the asset rows;
- that the publication equals the product publish path;
- the catalog behind `GET /api/v1/client-delivery-catalog` (project page at the route default of 50 and the Ops default of 25, and the exact task at limit 1), plus `/client-delivery-projects`;
- an unknown task or project returns 404;
- the session authority behind `POST /api/v1/models/:id/sessions`: a ready model at the registered version, a `direct_client_grant` grant is created, and an inactive version is refused (409);
- `DELETE /api/v1/published-sessions/source-authorization` revokes that grant (revokedGrants 1), after which the grant no longer redeems and a new session is refused (409).

The Viewer lookups each contract case depends on (printed by the readback; the other 41 cases never reach the Viewer):

| Case | Viewer calls |
|---|---|
| C4 create, C6 duplicate | catalog(project, limit 25) |
| R1 signed read | catalog(project, limit 25) |
| R2 session | catalog(project, task, limit 1); POST session with `direct_client_grant`; catalog(project, task, limit 1) |
| V3 revoke | DELETE source-authorization with `direct_client_grant` |

Gaps, stated plainly:
- **Minimal asset closure.** The model is minimal: one published GLB whose scene is empty. There is no EPT, orthophoto, OBJ/MTL/texture closure, LOD derivatives or processing provenance. A real processing run would have them, and the catalog and session routes don't read them. A redeemed session would open an empty model.
- **No service auth offline.** The Viewer's HTTP layer and service authentication (`SERVICE_AUTH_*`) are not exercised offline. Ops reaches the Viewer through its normal service binding in the QA runtime.

## Authorization model

Direct Viewer shares pass two independent Ops gates. Both are product behaviour at the pinned commit; the fixture changes neither.

| Request | Ops gates, in order |
|---|---|
| `GET /api/viewer/direct-client-grants` (discovery, picker, grant listing) | 1. Staff Access sign-in.<br>2. **Viewer-manager permission**: global `viewer.view` and `viewer.manage`, with no global deny. |
| `POST /api/viewer/direct-client-grants` (create)<br>`DELETE /api/viewer/direct-client-grants/:id` (revoke) | 1. Staff Access sign-in.<br>2. **Ordinary Ops administrator mutation gate**: a global `role-admin` or `role-owner` assignment. `requiresAdministratorForMutation` has no exemption for these paths.<br>3. Same-origin `Origin` and a valid `X-CSRF-Token` (from `GET /api/session`).<br>4. The same Viewer-manager permission as above. |

| Staff (entity) | Seeded authority | Reads | Writes |
|---|---|---|---|
| `staffAdmin` (`staff.admin`) | `role-admin`, global. The role carries viewer.view and viewer.manage. | 200 (D2) | 201, 200, 409 (C4–C6); 200 (V3, V4) |
| `staffViewerManager` (`staff.viewerManager`) | QA Viewer-manager role (viewer.view and viewer.manage), global. Not an administrator. | 200 (D1, D3, P, L, G, A3) | 403 administrator gate (C1, V1) |
| `staffAdminViewerDenied` (`staff.adminViewerDenied`) | `role-admin`, global, plus a global deny override on viewer.manage | 403 Viewer permission (D4) | 403 Viewer permission after passing the administrator gate (C2, V2) |
| `staffDivision` (`staff.division`) | QA Viewer-manager role at division scope only | 403 Viewer permission (D5) | not exercised |

Other denials:
- no staff assertion, or an assertion signed by an unknown key: 401 (D6, D7);
- an administrator write without a CSRF token: 403 (C3).

**Product note for the reviewer:** a non-administrator Viewer manager can list and search but cannot create or revoke a direct share. If that isn't intended, it is a product change to #698 (an exemption in `requiresAdministratorForMutation`), not a fixture change.

Staff admission: the migrations leave `native_staff_access_reconciliation` disabled (`enabled=0`), so Access sign-in admits these active staff rows by email and bound subject. If the QA environment enables native admission, the launcher must admit the four staff rows.

On the client side, every case passes the real portal origin check and the real Client Access verifier.
- A principal sees only workspaces it is a member of (wrong identity or wrong workspace: 404).
- With no assertion, or one signed by an unknown key, the result is 401.

## Signing: test-only, ephemeral keys

`ephemeral-access.mjs` is an in-process API only. It has no command line and writes no files. Each signer makes a fresh RS256 key pair in memory; the private key is created non-extractable and is never exported.

```js
import { createEphemeralAccessSigner, mintFixtureAssertions } from "./qa/sharing-698/ephemeral-access.mjs";
const signer = await createEphemeralAccessSigner();                // { jwks, mint }
const { jwks, assertions } = await mintFixtureAssertions(signer);  // public JWKS + 15-minute assertions per contract principal
```

Each assertion uses the principal's entity UUID as its `sub` and the contract email.

The products verify the assertions with their existing verifiers: Client with `resolveCloudflareClientPrincipal`, Ops with `authenticateStaff`. Both use jose `jwtVerify` (RS256, issuer, audience and exp) against `<issuer>/cdn-cgi/access/certs`.

The QA launcher keeps the signer in its own process. It serves `jwks` at that certificate URL for both issuers and sends each assertion as `Cf-Access-Jwt-Assertion`. Custody of the JWKS and assertions is the launcher's. No persistent key, real account or hosted signer is involved.

| Setting | Value |
|---|---|
| Client `CLIENT_ACCESS_TEAM_DOMAIN` / `CLIENT_ACCESS_AUD` | `https://clients-access.example.test` / `qa698-client-portal-aud` |
| Ops `TEAM_DOMAIN` / `OPERATIONS_AUD` | `https://staff-access.example.test` / `qa698-operations-aud` |

## Runtime configuration the contract assumes

Values are invented. Secrets are generated fresh by the launcher and never committed.

| App | Variables |
|---|---|
| Client | `ENVIRONMENT=staging`<br>`PUBLIC_BASE_URL=https://share.example.test`<br>`EXPECTED_HOST=share.example.test`<br>`CLIENT_PORTAL_ENABLED=true`<br>`CLIENT_PORTAL_ORIGIN=https://portal.example.test`<br>`CLIENT_PORTAL_HIERARCHY_V2_ENABLED=true`<br>`CLIENT_VIEWER_ENABLED=true`<br>`PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED=false`<br>`PROJECT_ALPHA_PORTAL_APPLICATION_KEY=qa698-portal-app`<br>the Access settings above<br>`DELIVERY_SESSION_SECRET` (32+ random characters)<br>`VIEWER_SESSION_ISSUER` service binding → Ops `ViewerSessionIssuer` |
| Ops | `ENVIRONMENT=staging`<br>`EXPECTED_HOST=ops.example.test`<br>`PUBLIC_BASE_URL=https://ops.example.test`<br>the Access settings above<br>`OPERATIONS_SESSION_SECRET` and `AUDIT_IP_SECRET` (32+ random characters each)<br>`VIEWER_INTEGRATION_ENABLED=true`<br>`CLIENT_VIEWER_SESSION_ISSUER_ENABLED=true`<br>`CLIENT_PORTAL_HIERARCHY_V2_ENABLED=true`<br>`APPLICATION_KEY=qa698-portal-app`<br>`VIEWER_SERVICE_HMAC_SECRET` (32+ random characters)<br>the Viewer service binding |
| Flags left unset (off) | `CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED`<br>`CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED`<br>`AUTHENTICATED_DELIVERY_GRANTS_ENABLED`<br>`CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED` |

## Prerequisites owned by Codex QA

1. A private launcher that starts Ops, Client and Viewer from the pins above against the two disposable databases, plus custody of the in-process signer's JWKS and assertions.
2. **Staff admission**, only if the QA environment enables native admission (see the authorization model).
3. **A Viewer instance** built from the product commit on a fresh database. Apply the Viewer migrations (schema 83), then `seed-viewer.sql`, and mount `viewer-storage/models/` (checked against `viewer-manifest.json`) as its `models` root. It must be reachable from Ops through the normal Viewer service binding and service credentials, which are the launcher's.
4. **Isolation:** no live shares and no real clients, staff or keys. Tear everything down after the run.

## Contract

The expected results are in `contract.json` and the table below, which is generated from that file. Run the cases in order: later cases reuse saved values (`${grantId}`, cursors).
- **Ops cases** go to `https://ops.example.test` with the staff assertion. Writes also carry `Origin` and the `X-CSRF-Token` from `GET /api/session` (marked "CSRF").
- **Client cases** go to `https://portal.example.test` with the client assertion and a same-origin `Origin` header.

Contents of `${projectGrant}`: `workspace.alpha`, `viewer.project`, whole project, future tasks included, measure only, no expiry.

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
| D1 | recipient discovery (Viewer-manager permission) | staffViewerManager | `GET /api/viewer/direct-client-grants?include=clients` | 200; clients: 2; clients.0.workspaceId = "1e56b7ab-2cbb-4def-87b7-c89b38054887"; clients.1.workspaceId = "7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec"; clientsNextCursor = null |
| D2 | recipient discovery (administrator) | staffAdmin | `GET /api/viewer/direct-client-grants?include=clients` | 200; clients: 2 |
| D3 | recipient discovery (Viewer-manager permission) | staffViewerManager | `GET /api/viewer/direct-client-grants?include=clients&q=alpha.client%40` | 200; clients: 1; clients.0.workspaceId = "1e56b7ab-2cbb-4def-87b7-c89b38054887"; clients.0.rootType = "standalone_client"; no clients.0.email |
| D4 | recipient discovery denied: Viewer permission | staffAdminViewerDenied | `GET /api/viewer/direct-client-grants?include=clients` | 403; code = "forbidden" |
| D5 | recipient discovery denied: Viewer permission | staffDivision | `GET /api/viewer/direct-client-grants?include=clients` | 403; code = "forbidden" |
| D6 | staff authentication | (no assertion) | `GET /api/viewer/direct-client-grants?include=clients` | 401 |
| D7 | staff authentication | staffAdmin | `GET /api/viewer/direct-client-grants?include=clients`<br>assertion signed by an unknown key | 401 |
| P1 | picker paging (named cursor) | staffViewerManager | `GET /api/viewer/direct-client-grants?include=clients&limit=1` | 200; clients: 1; clients.0.workspaceId = "1e56b7ab-2cbb-4def-87b7-c89b38054887"; clientsNextCursor ~ /^v1\./ |
| P2 | picker paging (named cursor) | staffViewerManager | `GET /api/viewer/direct-client-grants?include=clients&limit=1&cursor=${pickerCursor}` | 200; clients: 1; clients.0.workspaceId = "7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec"; clientsNextCursor = null |
| P3 | picker paging (named cursor) | staffViewerManager | `GET /api/viewer/direct-client-grants?limit=1&cursor=${pickerCursor}` | 400 |
| L1 | legacy no-include picker | staffViewerManager | `GET /api/viewer/direct-client-grants?limit=1` | 200; clients: 1; grants: 0; clients.0.workspaceId = "1e56b7ab-2cbb-4def-87b7-c89b38054887"; clientsNextCursor = "1e56b7ab-2cbb-4def-87b7-c89b38054887"; grantsNextCursor = null; no clients.0.rootType |
| C1 | create denied: administrator gate | staffViewerManager | `POST /api/viewer/direct-client-grants`<br>CSRF, Idempotency-Key qa698-create-viewer-0001, body projectGrant | 403; error = "Administrator access required for this change" |
| C2 | create denied: Viewer permission | staffAdminViewerDenied | `POST /api/viewer/direct-client-grants`<br>CSRF, Idempotency-Key qa698-create-denied-0001, body projectGrant | 403; code = "forbidden" |
| C3 | create denied: CSRF | staffAdmin | `POST /api/viewer/direct-client-grants`<br>no CSRF token, Idempotency-Key qa698-create-nocsrf-0001, body projectGrant | 403; error = "CSRF validation failed" |
| C4 | create (administrator gate + Viewer permission) | staffAdmin | `POST /api/viewer/direct-client-grants`<br>CSRF, Idempotency-Key qa698-create-alpha-0001, body projectGrant | 201; replayed = false; grant.workspaceId = "1e56b7ab-2cbb-4def-87b7-c89b38054887"; grant.viewerProjectId = "d0bb7e0a-f09c-48a4-8098-373b90b754df"; grant.scopeType = "project"; grant.grantVersion = 1 |
| C5 | create replay | staffAdmin | `POST /api/viewer/direct-client-grants`<br>CSRF, Idempotency-Key qa698-create-alpha-0001, body projectGrant | 200; replayed = true; grant.grantId = "${grantId}" |
| C6 | create duplicate scope | staffAdmin | `POST /api/viewer/direct-client-grants`<br>CSRF, Idempotency-Key qa698-create-alpha-0002, body projectGrant | 409; code = "duplicate_active_grant"; grantId = "${grantId}" |
| G1 | grant listing (paged, Viewer-manager permission) | staffViewerManager | `GET /api/viewer/direct-client-grants?include=grants&viewerProjectId=d0bb7e0a-f09c-48a4-8098-373b90b754df` | 200; grants: 1; clients: 0; grants.0.grantId = "${grantId}"; grantsNextCursor = null |
| R1 | signed read | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/viewer` | 200; items: 1; items.0.grantId = "${grantId}"; items.0.taskId = "54a404cf-93ba-4bfa-88d3-1a53d11647e0"; items.0.workspaceId = "1e56b7ab-2cbb-4def-87b7-c89b38054887"; nextCursor = null |
| R2 | signed read | clientAlpha | `POST /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/viewer/${grantId}/tasks/54a404cf-93ba-4bfa-88d3-1a53d11647e0/session`<br>Idempotency-Key qa698-session-alpha-0001, body {"displayUnits":"imperial"} | 201; modelId = "c46ec866-c9ac-40e9-bdfd-fe884cf2f525" |
| R3 | wrong identity | clientBravo | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/viewer` | 404 |
| R4 | wrong workspace | clientAlpha | `GET /api/client/v2/workspaces/7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec/viewer` | 404 |
| R5 | wrong identity | clientBravo | `POST /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/viewer/${grantId}/tasks/54a404cf-93ba-4bfa-88d3-1a53d11647e0/session`<br>Idempotency-Key qa698-session-bravo-0001, body {"displayUnits":"imperial"} | 404 |
| R6 | signed read | clientBravo | `GET /api/client/v2/workspaces/7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec/viewer` | 200; items: 0; nextCursor = null |
| R7 | client authentication | (no assertion) | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/viewer` | 401 |
| R8 | client authentication | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/viewer`<br>assertion signed by an unknown key | 401 |
| V1 | revoke denied: administrator gate | staffViewerManager | `DELETE /api/viewer/direct-client-grants/${grantId}`<br>CSRF, Idempotency-Key qa698-revoke-viewer-0001, body {"reason":"QA viewer-manager revoke"} | 403; error = "Administrator access required for this change" |
| V2 | revoke denied: Viewer permission | staffAdminViewerDenied | `DELETE /api/viewer/direct-client-grants/${grantId}`<br>CSRF, Idempotency-Key qa698-revoke-denied-0001, body {"reason":"QA denied revoke"} | 403; code = "forbidden" |
| V3 | revoke (administrator gate + Viewer permission) | staffAdmin | `DELETE /api/viewer/direct-client-grants/${grantId}`<br>CSRF, Idempotency-Key qa698-revoke-alpha-0001, body {"reason":"QA revoke"} | 200; success = true; replayed = false; sessionRevocation.pending = false |
| V4 | revoke replay | staffAdmin | `DELETE /api/viewer/direct-client-grants/${grantId}`<br>CSRF, Idempotency-Key qa698-revoke-alpha-0001, body {"reason":"QA revoke"} | 200; success = true; replayed = true |
| A1 | read after revoke | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/viewer` | 200; items: 0; nextCursor = null |
| A2 | read after revoke | clientAlpha | `POST /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/viewer/${grantId}/tasks/54a404cf-93ba-4bfa-88d3-1a53d11647e0/session`<br>Idempotency-Key qa698-session-alpha-0002, body {"displayUnits":"imperial"} | 404 |
| A3 | read after revoke | staffViewerManager | `GET /api/viewer/direct-client-grants?include=grants&viewerProjectId=d0bb7e0a-f09c-48a4-8098-373b90b754df` | 200; grants: 0; grantsNextCursor = null |
| S1 | share paging (kind=shares) | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-shares?limit=2` | 200; shares: 2; shares.0.id = "1f3a8059-3a73-4710-82ef-05bab36dbfda"; shares.1.id = "5a4c46af-8bba-4850-ac98-03f4a05bd7ff"; nextCursor ~ /^ds2\./ |
| S2 | share paging (kind=shares) | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-shares?limit=2&cursor=${sharesCursor}` | 200; shares: 1; shares.0.id = "866a5436-0939-4862-9d9f-802e105c3f39"; nextCursor = null |
| T1 | share paging (kind=targets) | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-share-targets?limit=2` | 200; targets: 2; targets.0.folderTargetId = "13861c5e-2dd1-4d8b-9620-4c5ef5b7a25c"; targets.1.folderTargetId = "2965452c-810e-4d38-ae77-ce03e7798955"; nextCursor ~ /^ds2\./ |
| T2 | share paging (kind=targets) | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-share-targets?limit=2&cursor=${targetsCursor}` | 200; targets: 2; targets.0.folderTargetId = "87754c22-0c55-4121-ace6-306bb8eb04e7"; targets.1.folderTargetId = "cdc31025-8593-41ea-9767-3517dafa82bb"; nextCursor = null |
| B1 | cursor binding: list kind | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-share-targets?limit=2&cursor=${sharesCursor}` | 400 |
| B2 | cursor binding: list kind | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-shares?limit=2&cursor=${targetsCursor}` | 400 |
| B3 | cursor binding: caller | clientAlphaColleague | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-shares?limit=2&cursor=${sharesCursor}` | 400 |
| B4 | cursor binding: workspace | clientAlphaColleague | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-shares?limit=2` | 200; shares: 0; nextCursor ~ /^ds2\./ |
| B5 | cursor binding: workspace | clientAlphaColleague | `GET /api/client/v2/workspaces/7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec/delegated-shares?limit=2&cursor=${colleagueCursor}` | 400 |
| B6 | cursor binding: wrong identity | clientBravo | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-shares?limit=2&cursor=${sharesCursor}` | 404 |
| B7 | share paging limits | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-shares?limit=101` | 400 |
| N1 | legacy no-cursor | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-shares` | 200; shares: 3; nextCursor = null |
| N2 | legacy no-cursor | clientAlpha | `GET /api/client/v2/workspaces/1e56b7ab-2cbb-4def-87b7-c89b38054887/delegated-share-targets` | 200; targets: 4; nextCursor = null |

## Validation done for this handoff (local, light runs)

- **Seed check:** `node qa/sharing-698/fixture-db.mjs` builds both databases in in-memory SQLite (node:sqlite; every migration, then the seed). Then it checks:
  - `foreign_key_check` and `integrity_check` pass;
  - the seed counts match `contract.json`;
  - every address in the seeds is on example.test;
  - the entity UUID rules above hold;
  - the digests below match.
- **Pin check:** the same command and the contract test both require `contract.json` to pin the exact 40-character commit and tree. They also check that this commit's tree is that tree (`git rev-parse <commit>^{tree}`), that the fixture branch is based on that commit, and that no product file differs from it.
- **Contract run:** `cd apps/operations && npx vitest run --config vitest.config.ts test/qa-sharing-698-contract.test.ts` sends every case through the real Ops worker and the real Client worker (`worker.fetch`, with their whole middleware chains), over the same seeded in-memory databases.
  - **Ops chain:** host admission, Access sign-in, the administrator mutation gate, CSRF, then the route.
  - **Client chain:** portal origin, Access sign-in, then the route.
  - Nothing in the authorization path is injected. The only stand-ins are what the runtime or launcher supplies:
    - the two Access certificate URLs serve this run's public JWKS (any other network request fails the test);
    - the Client → Ops service binding is the real `ViewerSessionIssuer` entrypoint, called in-process instead of over Workers RPC;
    - the Viewer service calls are answered by the Viewer's own repository code over the seeded schema-83 Viewer database (`viewerServiceFromSeed` in `viewer-readback.mjs`). Only the Viewer's HTTP layer and service auth are skipped.
  - The same run includes the full Viewer readback.
- **Viewer readback:** `node qa/sharing-698/viewer-readback.mjs` (see "Viewer side").

## Entities

| Entity | UUID |
|---|---|
| `client.alpha` | `8b57a414-a6e8-48a3-bff1-332b5b0f9025` |
| `client.bravo` | `656bb776-7bc0-45c5-85a7-509ffa5b58b1` |
| `client.colleague` | `e5332fb8-ff6f-43b0-b37a-c1240bd8b67b` |
| `staff.admin` | `416a153c-fe04-4f2b-af52-a44974d7989d` |
| `staff.viewerManager` | `ab68633b-6b70-4d65-a349-372d734039cf` |
| `staff.adminViewerDenied` | `30e7a8de-7c83-4035-82af-d23e6c242e51` |
| `staff.division` | `686a1c08-ca89-4758-ab4b-884a54c27fb7` |
| `workspace.alpha` | `1e56b7ab-2cbb-4def-87b7-c89b38054887` |
| `workspace.alpha.root` | `181eac82-1539-4564-8bbe-ac4c31beec97` |
| `workspace.alpha.generation` | `69882236-a344-40cd-b7cf-152ae5081d6d` |
| `workspace.bravo` | `7ff7cbfb-8e82-466b-9cb5-ad48ab3252ec` |
| `workspace.bravo.root` | `2787b5a5-4549-4913-9c59-8e3c0e23e85e` |
| `workspace.bravo.generation` | `fa45a2cc-0a72-437e-9c86-3f40102f0d79` |
| `portalProject.alpha` | `0a4f3fd5-c6f1-4396-ad08-a2eff7a6fa6c` |
| `membership.alpha` | `6b5c3682-9fc8-4431-8f40-b57b21bd38bf` |
| `membership.bravo` | `52c5b310-6b4b-4b70-bbd8-551b4daaa1ed` |
| `membership.colleague.alpha` | `693f695f-c84a-406a-8fd5-36ccc1285d4c` |
| `membership.colleague.bravo` | `7c363739-a2fa-48ff-a85f-a3a4bac049f1` |
| `principal.alpha` | `ab96b296-71b0-402a-ab3c-e46a7d902d8e` |
| `principal.bravo` | `f4a25e20-24db-4770-bc10-e1c51034cd6a` |
| `principal.colleague.alpha` | `15227954-f69f-4648-9c6b-1230857c2ee7` |
| `principal.colleague.bravo` | `29033974-507f-491e-a3e0-57a14684b53d` |
| `entitlement.alpha.workspace` | `cc04aa29-6cc7-475d-86cf-d396602abf85` |
| `entitlement.alpha.directory` | `d704cde4-b34f-40f0-8b18-ec0f245e092c` |
| `entitlement.alpha.delivery` | `ce7fe48b-f8a0-4fe3-96b7-eefee1047cc5` |
| `entitlement.alpha.share` | `392455be-218f-49d8-aa9d-9cb94081ac1d` |
| `entitlement.bravo.workspace` | `88d83a01-b571-4e71-8006-d6aa6e7d50eb` |
| `entitlement.bravo.directory` | `711d7d2f-0c1f-44ba-a920-770aa0fd46b0` |
| `entitlement.bravo.delivery` | `664eb32c-6046-4a89-a1a1-f0c476db17d1` |
| `entitlement.colleague.alpha.workspace` | `7322fcae-9cbf-4fc2-81a9-04d79c27aff2` |
| `entitlement.colleague.bravo.workspace` | `8e84c332-62e1-4fb9-b02b-0914da251733` |
| `folderBinding.alpha` | `40d5d4ee-d4a8-4a6a-8575-3b467a5a3820` |
| `target.root` | `13861c5e-2dd1-4d8b-9620-4c5ef5b7a25c` |
| `target.phase1` | `2965452c-810e-4d38-ae77-ce03e7798955` |
| `target.phase2` | `87754c22-0c55-4121-ace6-306bb8eb04e7` |
| `target.phase3` | `cdc31025-8593-41ea-9767-3517dafa82bb` |
| `delegation.alpha` | `b3e4d0b2-6730-4174-bd28-d4ce4dce22b3` |
| `share.phase1` | `1f3a8059-3a73-4710-82ef-05bab36dbfda` |
| `share.phase1.public` | `9f6bd575-13bb-441e-8107-5a1bea676746` |
| `share.phase2` | `5a4c46af-8bba-4850-ac98-03f4a05bd7ff` |
| `share.phase2.public` | `611c1dc3-8994-4b82-82f9-a9f74f8c22bb` |
| `share.phase3` | `866a5436-0939-4862-9d9f-802e105c3f39` |
| `share.phase3.public` | `33af05dc-2fe9-4527-92bf-54d9562a1853` |
| `role.viewerManager` | `cf102265-982a-495a-87ae-ff0427cbfbce` |
| `division.north` | `56c156c7-efc0-4a37-a0f6-9880a7e86708` |
| `assignment.admin` | `f0ed2851-b38a-4a21-bf2c-5c5683c2c80d` |
| `assignment.viewerManager` | `878637f5-483f-4cbb-8d75-68cccb6dc95d` |
| `assignment.adminViewerDenied` | `ce588097-cdda-43ce-b2e3-acfacbe1e1bb` |
| `assignment.division` | `fd4e3784-8eda-4be0-8508-3572ce8be0ea` |
| `override.adminViewerDenied` | `3a7d4f6a-1647-415b-94f8-289207cfbda8` |
| `viewer.project` | `d0bb7e0a-f09c-48a4-8098-373b90b754df` |
| `viewer.task` | `54a404cf-93ba-4bfa-88d3-1a53d11647e0` |
| `viewer.model` | `c46ec866-c9ac-40e9-bdfd-fe884cf2f525` |
| `viewer.modelVersion` | `fe118cb6-5aec-4674-8e83-458c21d872db` |
| `viewer.dataset` | `14729053-58d0-45fa-ab51-b8469b0b3559` |
| `viewer.provider` | `67413c5d-3f8c-403a-a665-e4eba38544a5` |
| `viewer.attempt` | `b2ab737d-540b-45de-9ff8-b887af68ca07` |
| `viewer.asset.glb` | `aed6b432-cd90-438b-8104-8a74bc4719d6` |
| `viewer.audit.publish` | `490d4a3c-905e-4072-a3a6-eea5ef457923` |

## Digests

SHA-256, with line endings normalised to LF. `README.md` is hashed with its own digest replaced by `<self>`. Check them with `node qa/sharing-698/fixture-db.mjs` (validates) or `--digests` (prints).

| File | SHA-256 |
|---|---|
| `README.md` | `77d7303753a28f1c81a1925442f8a51b36dc9d5ea33a0a75b42dcb74f3bb13e1` |
| `contract.json` | `440ac420a94b765a78e7661b51f0610ef4be651c1c032378798e7c1f12bab2fd` |
| `seed-delivery.sql` | `677cda97aa26c87ae64f58ab51c96c81adcbe7099a2da76f76f5800d94acae06` |
| `seed-ops.sql` | `13403e54b6efef6ecab02d584cede8de92e8c2aa8a91cd97dd1b306b55fa20d1` |
| `d1-sqlite.mjs` | `7d1b3fe633f0cf995f64fd7a3d13353766472ee30e235e732a1ba2ec2c121229` |
| `fixture-db.mjs` | `d339bcdf877c9ee4acf42a14d8a1571b0f81f853aa8b961116a24932b4d82648` |
| `fixture-db.d.mts` | `e932f1b662a30da6a3c391e4118ac8587755158abd12a8a4586a09aeebfcc758` |
| `ephemeral-access.mjs` | `33683c82305276135e4ff92defd5e2684c082ef1baff0c0da96a31c6d66636fc` |
| `ephemeral-access.d.mts` | `85a7e709f85badcfe43b5ee26f6312c3f73d201b5fceb90d5a9d09d2752c1026` |
| `seed-viewer.sql` | `e1c0baf3777e6e2a84e8383716c4ba629ee4d7a5ed33e0eebb35c92703f24783` |
| `viewer-manifest.json` | `4df4181092dfb43ded3fa80063bde9f21a0df3b70e7006fac67b1da42ac218d4` |
| `viewer-readback.mjs` | `623e5094c4d7babd2f9e40265a9c9bb405f254e2f7c85b74e66011c223145bbc` |
| `viewer-readback.d.mts` | `38cd762c4e42a0b1eb911391c7dbe679f85a1a67d46e48d103faef5d59924748` |
| `../../apps/operations/test/qa-sharing-698-contract.test.ts` | `e4e275c46c198c3e82db6edbecbcb80c7891cb3d9d0b79d148f3562e01d7014a` |
