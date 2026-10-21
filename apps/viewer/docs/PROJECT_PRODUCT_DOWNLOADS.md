# Unified projects and product downloads

## Workspace behavior

The existing project summary is now the header of one expanding card. Its tasks and project actions render inside that card, without a second title/description or “All projects” control. Clicking the same header collapses it. The project/task URL routing, filter, permission gates, collapsed task row and quick actions are retained.

The task Download action opens an in-application product chooser. Each item shows the registered product, actual file format and registered byte size. Report remains a quick action. A download is handed to the browser's download manager, without reading the full file into a JavaScript Blob.

## Product availability and authorization

The product catalog only contains recognized, hashed, registered files with a valid relative path and byte size. Streaming EPT and 3D Tiles manifests are never offered as original point clouds or full model downloads. Single OBJ files are labeled **Mesh geometry (OBJ, without textures)**; only a registered ZIP is described as a textured model package. Existing archive, cutline or camera-parameter files can appear when registered under the supported product kind. No new archive is manufactured or retained by this feature.

Staff with `viewer.processing.read` can choose supported output products, including the registered original LAS/LAZ/PLY, report and OBJ. Client and public sessions must have `download: true` and may only download the existing published derivative allowlist (orthophoto, DSM, DTM, GLB, camera positions). Camera-position permission still applies. Staff-only original sources and reports are not implicitly exposed by sharing a model. Render permission is not raw-download permission. This feature grants no processing, administration, import, project-edit or other user-record access.

## HTTP contract

- Workspace output DTO adds `downloadProducts[]`: `{ kind, label, format, byteSize, fileName, grantUrl }`. Existing asset URLs remain compatible.
- Staff: `POST /api/v1/processing/outputs/:outputId/products/:kind/download-grants`, with the admin bearer and an empty JSON object, returns `{ url, expiresAt, fileName }`.
- Viewer/public: `GET /session-products/:assetToken/:modelId` returns `{ products }`; `POST product.grantUrl` issues the same ticket envelope.
- Navigate an ordinary same-origin download link to `url`; do not `fetch(...).blob()` the file. GET/HEAD and byte ranges are handled by streaming file delivery.

Tickets are opaque, 256-bit, limited to one exact registered asset and model version, expire after at most five minutes, and are bounded to 5,000 pending tickets per router. The original Viewer/admin bearer is not put in the download URL. Tickets are process-local and intentionally invalid after restart; reopen the chooser to issue another one. A paused download resuming after expiry needs a fresh ticket. An admitted request may finish slow integrity verification after ticket expiry and existing downloads can finish after their initial request, but every new request/range rechecks current source permissions, session/share liveness, version, output state and asset identity. Integrity verification is followed by another authorization check before bytes are sent.

Downloads use attachment disposition, no-store, no-referrer, no-sniff, strict file resolution and the existing asset-integrity verifier. Without chunk integrity metadata, verification may read a large file before transfer begins; this does not buffer the file in the browser.

## Viewer integration

`mountViewerProductDownloads({ host, getAssetRoot, permitted })` in `viewer-product-downloads.mjs` mounts a compact chooser. `getAssetRoot()` returns any current same-origin `/session-assets/:token/:modelId/...` asset URL; `permitted()` returns the current download permission. Call the returned `refresh()` when session authorization or model changes and `destroy()` on teardown. The helper validates returned ticket routes, cancels pending requests, and rechecks permission before navigation.

## Verification

`node --test test/product-downloads.test.js test/viewer-product-downloads.test.mjs test/output-access.test.js test/workspace-task-layout.test.mjs test/workspace-admin-controls.test.js`

34 checks pass: exact product filtering, no manifest masquerading, path rejection, opaque ticket expiry/capacity/revocation, cross-model rejection, public-share revocation, changed hashes/version, real HTTP HEAD/Range bodies, preservation of existing staff output access, collapsed task structure, unified project markup and existing navigation/permission behavior.

Remaining release acceptance: rendered desktop/narrow workspace review, keyboard chooser interaction, a real multi-gigabyte browser download/resume, whole-project share menu and the integrated Viewer chooser. No production access or data changes were needed for the focused checks.
