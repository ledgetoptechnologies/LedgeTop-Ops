# Operations handoff — Viewer measurements, sharing and renewal

Prepared September 5, 2026, America/Chicago. This file is intended to be handed directly to the separate Operations implementation agent.

## September 7 update — revised stockpile authority

The user subsequently approved **server-side stockpile volume for everyone with
measurement access**, including clients and temporary public-link users. The
older staff-only server-calculation wording below is superseded **only for
native DSM/DTM `surface-cut-fill` and its parent-linked `surface-transect` profile**. Do not grant clients `viewer.processing.write`,
admin bearers, import/reprocess rights, native point/mesh reconstruction methods,
or access to another person's measurements to enable stockpile volume.

Viewer now implements narrow personal raster jobs and a separate temporary,
page-scoped server lane (schema 33). Existing Operations individual-identity
attestation and scope/renewal requirements remain; no new broad Operations
processing permission is needed. Measurements now share one per-person/model
list across all five views, with source-coordinate semantics preserved.
The profile uses the completed volume's exact source and frozen base; it does
not modify the saved volume or grant standalone arbitrary processing. The
ordinary flags are `rasterCalculations` and `transectCalculations`;
`serverCalculations` still denotes separately authorized specialist methods,
not whether normal measurements run on the server.

See [current calculation contract](MEASUREMENT_CALCULATIONS.md),
[current measurement API](PRIVATE_MEASUREMENT_API.md), and
[September 7 QA and source-unit handoff](STOCKPILE_SERVER_AND_REFINEMENT_QA_2026-09-07.md).
The [native-profile acceptance record](NATIVE_ELEVATION_PROFILE_QA_2026-09-07.md)
describes the new profile and its live acceptance boundary. No additional
Operations processing permission is required to enable it.
The last document includes the remaining read-only County Road D unit inspection:
bind evidence to the exact raster/version hash, do not assume meters from a
WebODM label, and do not alter source data or start processing to bypass it.
Historical commit/image and source-inspection details below are not current
deployment attestations.

## 1. Assignment and ownership

Implement the Operations-side integration described below, reconciling it against your current work first. The user explicitly asked the Viewer agent to inspect Operations **read-only**, because another agent owns its implementation. No Operations source, worktree, branch, dependencies, database, credentials or deployment was changed by this assessment. No Operations test scripts were run in an active checkout.

Do not reset or overwrite either repository. Do not copy the Viewer worktree over another checkout. Coordinate any additional Viewer changes rather than assuming an Operations-only patch can add a Viewer protocol handler. Preserve unrelated in-progress work and existing authorization improvements.

### Exact source boundaries

- Operations inspected through immutable `git show` / `git grep`: **`23da125ac78a14253002eda363360e9aafee069b`**, the locally available `origin/main` at inspection. This was not a remote freshness/deployment check. The ordinary `C:/Projects/LTDS-Ops` checkout was older, at `ea42b706d2ac79cd326d1d288ecdf9b1017c599b`; another worktree at the newer commit was dirty, so it was not used as the authoritative source snapshot.
- Viewer candidate: `C:/Projects/3D-Viewer/.worktrees/storage-diagnostics-cleanup`, branch `codex/storage-diagnostics-cleanup`, **uncommitted/unpushed** changes on baseline `ad678681312963df4aece03360978aab6a5f781a`. The baseline SHA does not contain this feature batch. Obtain the final Viewer commit/image before release.
- Local verified runtime: `ltds-viewer:measurement-runtime-candidate`, image ID **`sha256:ac61e0bacb1c7e7d00172c78717927718e17ec993e1a140cac7581c4a49143ab`**. This is not a registry pull reference. Its revision label is `unknown`; release attestation must be produced from the eventual committed source.
- This handoff supersedes older source observations where they conflict with `OPERATIONS_VIEWER_INTEGRATION_HANDOFF.md`, whose Operations snapshot was `7efd2…`. That older document remains useful for detailed renewal and activation invariants, not as evidence of the newest implementation.
- Paths and line numbers below are relative to their named repository and pinned to these snapshots. Re-resolve them on your current branch.

## 2. User-approved authority model — do not broaden it

| Person/access | Allowed | Not implied |
| --- | --- | --- |
| Owner/admin | Authorized administration, sharing and processing; own measurements | Access to other people's private measurement records |
| Kollin or another staff member with ordinary access | Whatever view scope was explicitly granted; own measurements | Administration or processing merely because signed in |
| Explicitly promoted administrator | Separately granted capabilities, checked live | A permanent bypass after revocation |
| Client with task share | Only that authorized task/model and allowed viewer tools/downloads; own measurements | Sibling tasks, project administration, import, processing, reconstruction, server calculation jobs or resharing |
| Client with project share | Authorized tasks within that project | Other projects or automatic broader/future scope without the explicit project-grant policy |
| Public link | Scoped view and explicitly allowed tools/downloads | Personal persistence or any administrative/server job rights |

Interactive measurement arithmetic and browser-local cut/fill are not NodeODM/processing jobs. Clients may use those within measure permission. Server-side native point-cloud/mesh/reconstruction calculation jobs are **admin-only**. Ordinary shared clients should not receive client resharing/team-management scopes.

Measurements are private per `(audience, subject, modelId, immutable modelVersionId)`. A company's employees do not share one personal bucket. Administrators do not see clients' annotations. `spatial3d` is shared between model and point cloud; `map` is shared between ortho/DSM/DTM. Reprocessing does not silently transfer geometry onto a different version. Public annotations are memory-only and reset on refresh.

## 3. What Viewer already implements locally

- Integrated project expansion, without duplicate project heading/description or redundant All Projects button; existing compact task rows and quick actions retained.
- Private measurement CRUD, revision conflicts, per-person/version isolation, named/hidden/editable/deletable records; shared model/cloud collection and separate map collection.
- Live polygon cursor preview, edge lengths, small point markers, Shift navigation, Backspace undo, Space-drag/edit mode, units and full-precision stored coordinates with three-decimal display.
- PNG capture, printable/PDF report, JSON/CSV/DXF/GeoJSON export with provenance/accuracy limitations.
- Native-cell browser surface cut/fill and isolated base/region preview. Administrative worker calculations on native raster/EPT/closed OBJ and explicitly acknowledged reconstructed estimates. Missing data, open geometry and unknown coordinate metadata fail explicitly instead of manufacturing a trustworthy number.
- Service-only personal-identity attestation; ordinary clients cannot obtain server-job authority. Request-time and worker-liveness authorization, source hashes, bounded workloads, cancellation and stale-revision fencing.
- Authorized individual-product chooser and streamed tickets/HEAD/Range. Registered EPT/tiles manifests are not represented as complete downloadable models. OBJ is labeled geometry without texture dependencies. Client/public products remain restricted by existing derivative/download policy; raw point-cloud/OBJ/report access is not silently expanded.
- Existing map-camera canvas overlay, DEM shading and viewpoint/display fixes remain in the candidate. The later agreed plan preserves Detail/Memory controls and bounded behavior; do not revive the superseded request to hide them and force maximum allocation.

None of this is deployed by this handoff. Do not treat source tests as proof that live Operations identity, cookie renewal or survey accuracy has passed.

## 4. Work A — individual client measurement persistence (small additive contract)

### Already implemented in Operations

The client is already represented by an individual identity, not merely a company:

1. `apps/client/src/worker/client-portal/routes.ts:1154`: client session route obtains identity/workspace/issuer/subject from authenticated server context, not browser identity fields.
2. `apps/operations/src/worker/viewer-session-issuer.ts:66` (`AUTHORIZED_ASSOCIATION_SQL`) and `:219` (`authorizeClientViewerAssociation`) check active exact association/project/source versions, account/project grant, individual identity `(id, issuer, subject)`, membership, legacy bridge, task/project scope and denies.
3. `viewer-session-issuer.ts:562–578` calls the shared issuer with `actorId: parsed.data.identityId`, audience `client`.
4. `apps/operations/src/worker/viewer-integration.ts:506–556` (`issueViewerSession`) issues **`client:<identityId>`**.
5. `apps/client/migrations/0121_client_workspace_hierarchy_v2.sql:6–15` has unique issuer/subject identity; native identity creation also uses a stable generated ID rather than email as the owner key (`native-portal-eligibility.ts:81`).

Preserve these subject IDs across renewal, fresh sessions and identity migrations. Do not rename subjects just to enable persistence. Confirm operationally that people are not sharing one login; code cannot prove that.

### Missing additive change

- `packages/shared/src/viewer-service.ts:850–872`, `createSession`: extend its permissions DTO at line858 with optional `personalMeasurements?: boolean`. Keep omission/default behavior unchanged.
- `viewer-integration.ts:551–556`: currently serializes only `view`, `measure`, `cameras`, `download`. Thread an explicit **verified individual identity** issuer option from the authorized client path and add `personalMeasurements: true` only there.
- Do not accept this flag from client JSON, query strings, browser storage or a generic account-level grant. Staff `ops:<staffId>` persistence already works without it. Do not set a blanket true default for all service callers.

**Actual existing issuance endpoint:** `POST /api/v1/models/:modelId/sessions`, implemented by Viewer `server/apiV1.js:310`. It is service-authenticated and idempotent. `POST /api/v1/sessions/redeem` redeems the one-time grant; it is not issuance. There is no issuance route `/api/v1/sessions` to invent.

Illustrative added field in the existing signed issuance body (all IDs/authority remain server-derived):

```json
{
  "subject": "client:<stable-individual-identity-id>",
  "audience": "client",
  "modelVersionId": "<currently-authorized-version-id>",
  "authorizationExpiresAt": "<bounded-authority-deadline>",
  "displayUnits": "imperial",
  "permissions": {
    "view": true,
    "measure": true,
    "cameras": true,
    "download": false,
    "personalMeasurements": true
  },
  "sourceAuthorization": {
    "type": "model_association",
    "id": "<exact-live-association-id>",
    "version": 1
  }
}
```

Preserve HMAC signing over the actual serialized body, nonce/idempotency, current association version, expiry caps and one-time grant redemption. Do not copy placeholder version `1` into production logic.

### Mixed-version behavior

Viewer `server/measurementApi.js:44–48` intentionally treats unattested client identities as temporary-only: GET list/capabilities returns an empty list, `personalPersistence:false`, `serverCalculations:false` and a notice; mutations return403 `personal_measurement_identity_required`. The browser uses temporary records. The attestation adds persistence, **not job capability**. Do not automatically merge old company/shared-login records or import public transient annotations into a different owner.

### Tests to add in Operations

- `apps/operations/test/viewer-service.test.ts:67`: optional true field survives serialization/signing; omission stays omitted; default is not true.
- `apps/operations/test/viewer-session-issuer.test.ts:266`: exact person subject, attestation, bounded expiry, model/version/source authorization and allowed permissions.
- Reuse second-person fixture near line363: same company/project, distinct identity subjects; denied membership/identity/grant paths never call Viewer.
- Client route tests: browser cannot override subject/audience/identity/attestation/admin rights.
- Cross-service: actual service issuance → redemption → private CRUD → same-person new grant/renewal. A and B cannot read/update/delete/export each other's records; different model versions remain separate.

## 5. Work B — native client portal is a separate blocker

`apps/client/src/client/portal-api.ts:227–243` explicitly returns `viewer:false, viewerShares:false` for `resourceMode:"native"`. Existing Viewer issuance requires the legacy account/identity bridge. Therefore Work A alone does **not** make Viewer available in a native client workspace.

First determine which portal mode the user's intended clients actually use. For native mode, implement and test a native-authority listing/issuance adapter: exact native workspace/project/task access, active person membership, current association/version, expiration/revocation and explicit deny. Do not toggle `viewer:true` before the corresponding backend exists, forge legacy IDs, infer authority from names, or grant company-wide access as a fallback.

Ordinary clients must still have `viewerShares`/resharing disabled unless the owner separately requests delegation. Native integration is its own milestone with its own tests, not an unverified side effect of personal persistence.

## 6. Work C — fix the exact-model association response

Concrete current compatibility mismatch:

- Ops `apps/operations/src/worker/viewer-integration.ts:395–421`, `listViewerClientGrantWorkspace`, returns associations only as `{id, projectId, modelTitle}`.
- Its upstream `associationView` at216–217 already knows `viewerModelId` and `viewerModelVersionId`; the workspace projection drops them.
- Viewer `workspace-projects.js:416–427`, `exactClientAssociations`, requires an exact model ID and unique association within the chosen authorized project/account. Missing IDs correctly fail closed, **even for already activated models**.

Add `viewerModelId` and `viewerModelVersionId` to that authorized response projection, retaining existing fields. Do not loosen Viewer to title matching. Current Viewer selection matches model/project/account uniqueness; authoritative version freshness is enforced by Operations. If adding immediate version mismatch UX in Viewer, coordinate and test it explicitly rather than claiming that filter already exists.

Extend `apps/operations/test/viewer-workspace-client-grants.test.ts:149` and a shared cross-repo response fixture: actual response selects the exact model; missing/wrong model, duplicate association, foreign account/project and stale authoritative version are rejected. This additive fix can precede private-ready activation.

## 7. Work D — private ready output → client share without Publish UX

The user wants Share, not a manual review/publish stage. Internal verified activation is still necessary; a private-ready processing output is not an already delivery-active catalog model.

- Viewer `workspace-projects.js:455` currently reports this unconnected case rather than granting access.
- Ops association creation (`viewer-integration.ts:743–785`) requires an already available/ready active catalog model. Existing workspace bridge (`viewer-processing.ts:379–431`) lists/creates/revokes grants to existing associations, not private activation.
- Viewer has a verified activation primitive `POST /api/v1/attempts/:id/publish` (`server/processingApi.js:462`), permission `viewer.processing.publish`, selected verified derivative kinds.
- Viewer public-share activation (`/api/v1/processing/outputs/:id/shares`) is **not** a private-client shortcut. Do not create then revoke a public URL to achieve private access.

Implement a resumable, idempotent server-coordinated workflow:

1. Resolve selected output/attempt/model/version and selected client account/project under live authority.
2. Check verified assets and impact on any existing public/project/client audiences; require explicit confirmation or choose a genuinely non-broadening version-pinned design.
3. Activate selected eligible derivatives without a public-link side effect.
4. Create/reconcile the unique exact Operations association with current source versions.
5. Create the exact task grant, explicitly `scopeType:"task"`, its `associationId`, and **`includeFuturePublished:false`**. Ops defaults omission to true and rejects that for task scope.
6. Persist operation receipts and accurate partial state. Response loss must replay/reconcile the same logical operation; changed payload under one idempotency key conflicts.
7. Recheck revocation/version/source changes on resume. Never undo someone else's newer activation, resurrect a revoked grant, or broaden to project access to hide an association failure.

Project sharing is an explicit separate action; future-task inclusion is an explicit policy choice. Model titles are never identity. Success means exact intended content is accessible and public-share count did not change.

## 8. Work E — quiet renewal with no original opener

This older gap remains at the inspected Ops revision:

- `apps/operations/src/client/OperationsApp.tsx:3721–3788`, `ViewerDataOverview.openWorkspace`, registers renewal only in the opening Operations window. It correctly checks origin/source/session/subject and correlation.
- Its fallback at3697–3713 still obtains a grant and `location.replace()` returns to Viewer.
- Viewer `workspace-renewal.mjs:106–130` cannot proactively issue without `controllerWindow`; `workspace-projects.js:168` uses top-level `/viewer/reauthorize?state=…` fallback.
- Ops in-page `viewer-admin-client.ts:71–108` refreshes its own Operations context; it is not an openerless standalone Viewer transport.
- Existing admin-grant route `viewer-processing.ts:556–578` requires current authenticated staff, global viewer access, idempotency, and bounded authorization. `request-security.ts:9–15` requires same Operations Origin plus CSRF token. Direct credentialed cross-origin fetch from Viewer is **not** currently supported merely because the route exists.

Choose and document a supported silent transport with fresh identity/permission revalidation, exact origin/source/correlation, no-store, deadlines/backoff, and real cookie/Access compatibility. Do not forward cookies/secrets, extend authorization lifetime just to hide expiry, iframe an interactive login as a bypass, or treat sessionStorage routing descriptors as authority. Preserve deliberate login fallback for genuine expiration/denial.

**Coordinated Viewer gap:** Ops sends `ltds-viewer:workspace-session-renewal-failed` with `retryable:false` on401/403 (`OperationsApp.tsx:3781`), but current Viewer handler `workspace-renewal.mjs:172–175` handles only positive `renew-workspace-session`; negatives time out. Add a compatible correlated negative-response handler with the Viewer owner. Terminal denial must invalidate; transient failure may preserve only still-valid credentials.

Test actual browser auth policy with opener alive/closed/reloaded/absent, reload, sleep across expiry, multiple tabs, account switch, delayed response body, consumed-grant response loss, revocation, offline recovery, and interactive login required. Require unchanged camera and no top-level navigation on the routine successful silent path. VM/mock tests are not cookie/Access acceptance.

## 9. Keep existing role mapping; no client job permission

Ops `viewer-processing.ts:64–99` already maps global `viewer.view` to read-only capabilities. Only explicit `viewer.processing.manage` maps to `viewer.processing.write`. `viewer.publish` maps to activation; `viewer.manage` maps to client grant management. Global denial wins. `viewer-integration.ts:106–118` now requires global view **and** the requested manage/share action; preserve that newer improvement.

Viewer `measurementApi.js:26–34` requires an Ops-audience model session **plus** a separate live same-subject workspace bearer with `viewer.processing.write` for jobs. The model tab brokers narrowly typed operations through its registered controller; it does not receive the broad admin bearer. `personalMeasurements:true` must never satisfy this gate.

Acceptance: ordinary Kollin access denies jobs; explicit same-person processing permission allows them; removal denies again. Clients with persistence still cannot submit/list/cancel jobs, including when presenting another staff member's admin bearer. Retain source/hash/revision/worker-liveness checks.

## 10. Verification evidence and its limits

Independent verification against the candidate image/source was rerun for this handoff:

- Complete isolated Linux suite: **1,220 total, 1,200 passed, 0 failed, 20 skipped** before the additional signed-service attestation test described in the final addendum.
- Exact non-root runtime: **36/36 native/private calculation tests passed, zero skips**; only test files were mounted, not replacement application modules.
- Disposable Linux Vite build passed. Existing loaders.gl CommonJS/large-chunk warnings remain.
- Permission, ownership, revision conflicts, access-loss clearing, late dialogs/reports/PNG encoding, source integrity, worker limits, native cell integration, EPT, closed meshes, reconstruction and streamed download range/revocation tests are included. Native amd64 reconstruction runs numerically; ARM64 dependency compile/executable smoke passed previously, not numerical parity.
- Browser (local synthetic fixture using shipped modules): polygon name/metric units, model↔cloud shared record, map collection isolation, 320.000m² polygon producing640.000m³ cut at2m, isolated base preview, repeated calculation, report/capture and public reset behavior. This is not a real Church/Rome or signed-in Operations browser session.
- Actual Leaflet/canvas camera fixture:10,000 sources, zero DOM pins, seven-second zoom/pan sequence, RAF p95≈20.8ms, no observed long tasks.25,000-source stress showed variability: p95≈27.8ms/max69.4ms and20 long tasks on one run; repeat p95≈13.8ms/max48.7ms and2 long tasks. Overlay-off baseline p95≈7.0ms, no long tasks. Visibility toggle and keyboard selection passed. These are synthetic runs, not a controlled production benchmark;25k stress is a follow-up performance acceptance item, not “zero lag.”

No production accounts/grants/files were mutated, no live jobs/imports were started, and no multi-GB production download was performed. The20 skipped checks must not be counted as passes; see final addendum for categories. Operations tests are requested below, not reported as executed. Native portal integration, real cross-account browser behavior, silent cookie renewal, narrow/mobile layouts, sustained transfers and real survey accuracy still need acceptance.

## 11. Test commands and required joined acceptance

Run these in your own reconciled Operations checkout/isolated test environment, not another agent's dirty worktree:

```sh
npm --prefix apps/operations run test -- test/viewer-service.test.ts test/viewer-session-issuer.test.ts test/viewer-workspace-client-grants.test.ts test/viewer-admin-client.test.ts test/viewer-admin-permissions.test.ts
npm --prefix apps/operations run check
npm --prefix apps/client run check
```

Those commands are based on the inspected package scripts (`vitest run --config vitest.config.ts`, TypeScript noEmit). Extend client route/native tests and actual browser suites for the new paths. Do not run deployment/migration-to-remote scripts as a test substitute. Existing `viewer-processing.spec.ts` covers mocked opener exchange and top-level fallback, not the missing silent transport.

Viewer focused regression groups to preserve:

```sh
node --test test/measurement-private-api.test.js test/measurement-calculation-jobs.test.js test/measurement-calculation-broker.test.mjs test/measurement-admin-client.test.mjs
node --test test/measurement-store-lifecycle.test.mjs test/measurement-capture-lifecycle.test.mjs test/measurement-admin-dialog-lifecycle.test.mjs test/viewer-session-recovery.test.js
node --test test/workspace-renewal.test.mjs test/workspace-renewal-api.test.js test/workspace-reauthorization.test.js test/review-session-controller.test.mjs
node --test test/client-grant-proxy.test.js test/workspace-share-api.test.js test/product-downloads.test.js
```

Joined release acceptance must record both source commits, exact deployed image, browser/auth configuration and sanitized result evidence:

1. Admin, ordinary staff and two clients in one company: correct task/project visibility; all four personal measurement collections isolated.
2. Stable person's reopen/renewal recovers their own records; different person/version cannot inherit them; public refresh resets.
3. Disabled identity, membership expiry/deny, grant revocation and model reassociation deny fresh issuance and existing access according to the deployed revocation contract.
4. Task-only share cannot open sibling task; project share does not escape project scope; ordinary clients cannot manage/share/process.
5. Ready private output becomes available only to selected client; no public URL created; partial failure and response-loss retry remain safe.
6. New/old mixed deployments remain fail-closed; missing attestation shows temporary mode, missing bridge stays unavailable, not broader access.
7. Routine renewal requires neither page refresh nor top-level sign-in bounce; genuine auth denial gives an actionable fallback and clears private Viewer-controlled UI.
8. Real file download/HEAD/Range/resume/revocation and native data metadata/coverage behavior; quantities validated against known fixtures and representative survey data before accuracy claims.

## 12. Rollout and return report

Land additive association fields and identity attestation first, with native portal support as a distinct dependent milestone. Negotiate new silent-renewal/private-activation contracts with Viewer. Keep public sharing separate and feature-gated. Existing Ops flag names: `VIEWER_INTEGRATION_ENABLED`, `VIEWER_PROCESSING_ENABLED`, `VIEWER_PUBLIC_SHARES_ENABLED`, `CLIENT_VIEWER_SESSION_ISSUER_ENABLED`, `CLIENT_VIEWER_SHARES_ENABLED`. Names are not evidence of deployed values; no secrets/config values were read.

Viewer schema32 adds private records and jobs; do not erase measurement tables or operation receipts on rollback. Back up the database before deployment using the established operational process. Viewer `MEASUREMENT_CALCULATIONS_ENABLED=false` disables new server calculations without granting anyone more rights; personal browser measurements remain separate. Review resource limits before enabling admin jobs on production-like inputs.

Rollback to explicit unavailable/temporary/login-fallback behavior, not expired access, public-link workarounds or shared personal identities. Preserve successful prior grants, newer activation, revocation outboxes and idempotency receipts. Feature disable does not prove already issued sessions have been revoked; use the proper existing revocation mechanism if immediate removal is intended.

Return: actual Operations commit(s), required coordinated Viewer changes and commit/image compatibility, migrations/flags, stable identity decision, native portal support status, concrete renewal protocol and security rationale, activation partial-failure semantics, executed tests and joined browser evidence, rollout/rollback procedure, and any remaining blockers. Do not declare the Viewer local image deployed or downloadable from a registry until its release is actually published.

## 13. Final verification addendum

Final combined rerun after the added signed-service test: **1,221 total; 1,201 passed; 0 failed; 20 skipped; 0 cancelled**, exit 0, approximately 52 seconds. The new subtest in `test/api-v1-runtime.test.js` exercises actual HMAC-authenticated model-session issuance, redemption, private CRUD, same-person renewal/fresh grant, different-person denial, omitted/false attestation rollback, and reattestation. Its exact-runtime parent/subtest run passed 2/2. No production source changes were needed for this extra test.

Additional exact-runtime checks passed:

- Database concurrency/migration suite: 11/11.
- Persistent-volume rehearsal as UID 568: schema 31 existing model/marker → schema 32 → full-precision personal measurement → separate container restart; original data, coordinates, owner isolation and SQLite integrity preserved. The disposable labeled volume contained synthetic QA data only and was removed afterward.
- Pinned Poisson and Obj2Tiles receipts, availability/usage smoke; Obj2Tiles actual conversion fixture produced 57 artifacts and 83 compressed textures.
- 106 server/scripts/engine/package files match current application source byte-for-byte. Frontend build fingerprints also match: `viewer-C6swUlm3.js`, `workspace-CZBt4BNk.js`, `measurement-surface-worker-DeXDcoIv.js`.

Skip accounting: 19 opt-in browser acceptance cases (15 LOD/camera/lifecycle variants, 1 session-renewal, 1 project-share, 2 workspace) require their external Chromium/manual tile harnesses; the supported in-app Browser was used for the local UI checks instead. One TrueNAS host-bind test needs the actual host mount/immutable deployment reference. The Docker-volume rehearsal is **not** proof of TrueNAS ACL behavior. Do not label these skipped scenarios passed.

The browser also verified changing the same polygon base offset from0m to1m updates cut from640.000m³ to320.000m³, hiding/showing preserves its record, a separate20.000m distance coexists, selecting only that distance limits the report's data table, and refresh clears public temporary records and display settings. The report image captures the current visible view, including other visible annotations; hide them first when a selected-only visual is desired.

Operations main checkout remained clean and at its initial SHA after inspection; its locally known `origin/main` ref was unchanged. Other agents' separate dirty worktrees were not edited. Only Viewer documentation and the extra Viewer regression subtest were changed during this follow-up verification. The local preview server was stopped at handoff. No release was pushed or deployed.
