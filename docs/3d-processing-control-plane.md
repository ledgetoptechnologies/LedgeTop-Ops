# 3D processing control plane

Status: **implemented behind `VIEWER_PROCESSING_ENABLED=false`; not enabled or deployed**.

This subsystem lets authenticated Operations staff catalog projects and immutable datasets, upload source files, adopt configured server-side imports, submit/retry/cancel processing attempts, review derived outputs, publish selected model assets, inspect provider health, and recover or purge storage. Existing published-model viewing is independent: a provider outage, disabled processing flag, or failed ClusterODM/NodeODM job must never make an already-published model unavailable.

## Trust and data boundaries

- Operations remains the identity and authorization control plane. It issues a one-time Viewer administrative grant only after checking the staff session and exact permission.
- The browser redeems that grant directly at Viewer and holds the short-lived bearer only in memory. Operations never stores the bearer.
- Metadata and resumable chunks travel Browser -> Viewer. Drone imagery, models, point clouds, textures, tiles, and archives never pass through a Worker.
- Delivery R2 upload/sync is a separate subsystem and is not reused for processing datasets.
- Project Alpha association is optional catalog context. Processing availability does not depend on Project Alpha.
- Raw imagery, GCP files, manifests, provider logs, and processing internals are administrative assets. Publishing exposes only explicitly selected derivative kinds allowed by Viewer.

## Rollout, permissions, and units

Apply Operations migration `0027_viewer_processing_control_plane.sql` before enabling the flag. It adds `viewer.datasets.manage`, `viewer.processing.manage`, `viewer.publish`, and owner-only `viewer.storage.purge`. Operations maps those narrowly to Viewer permissions; broad Viewer access does not imply storage purge.

Installation and user defaults are imperial. Staff can persist `imperial` or `metric`; the resolved value is carried in the one-time administrative grant. Projects and public shares may explicitly override display units without changing stored model geometry.

Keep `VIEWER_PROCESSING_ENABLED=false` until the Viewer deployment, migration, secrets, callback, storage preflight, recovery, provider admission, browser tests, and rollback evidence all match reviewed commits.

## Administrative grant protocol

Operations calls `POST /api/v1/admin-grants` using the existing `ltds-viewer-service-v1` HMAC protocol and exact JSON bytes. The body carries opaque `subject`, narrowly mapped Viewer permissions, bounded `authorizationExpiresAt`, and resolved `displayUnits`. The returned opaque 256-bit grant is single-use, defaults to 60 seconds, and may never exceed 300 seconds. Viewer stores only its SHA-256 hash.

Browser redemption is `POST /api/v1/admin-sessions/redeem`. The admin bearer is random, hash-only at rest, defaults to 30 minutes, and may never exceed one hour. Proactive renewal is single-flight. A retryable renewal failure preserves the current bearer and UI state until actual expiry; definitive denial or expiry fails closed. All metadata responses require JSON and are streamed through a 2 MiB cap.

All mutations require a bounded `Idempotency-Key`. Same key and same fingerprint replays the stored result; a conflicting body returns `409`.

## Upload and processing behavior

File hashing runs in a browser Web Worker with progress and cancellation so large drone datasets do not freeze the UI. Chunk bytes go directly to Viewer and use bounded exponential retry, per-chunk SHA-256, an upload token, bearer authorization, and deterministic chunk idempotency keys. Empty files send exactly one zero-byte chunk.

Cross-reload resume uses a bounded, expiring local checkpoint containing only
dataset ID and canonical manifest metadata—never a bearer, upload token, or file
bytes. After the operator reselects the same normalized folder manifest, Ops
reposts that identical manifest to rotate the upload token, reads Viewer's
completed/missing chunk index, and sends only missing chunks. Different,
expired, malformed, oversized, duplicate, or case-colliding manifests do not
resume and cannot silently create a duplicate dataset.

Every retry creates a new immutable `ProcessingAttempt`. Provider capabilities and presets drive options. LTDS admission/backpressure happens before provider submission; ClusterODM owns node scheduling. Logs shown to staff are bounded and sanitized, with retention/size caps; secrets, tokens, full server paths, and raw provider payloads must not enter client-facing errors or permanent logs.

Staff with `viewer.providers.write` configure provider credentials directly in
the Operations UI without editing container environment files or restarting
Viewer. The browser sends an optional credential during disabled provider
creation, or uses the dedicated credential endpoint to rotate or clear it.
Viewer returns only `{configured,updatedAt}` status; it never returns the token,
ciphertext, encryption metadata, or a token suffix. Credential changes are
blocked during active attempts and invalidate provider health/capabilities, so
the deliberate admission sequence is configure or rotate, probe, then enable.
Password inputs are never prefilled and are cleared after every submission.

Project and dataset friendly names, descriptions, and tags are editable without
changing stable IDs. Dataset project reassociation is catalog-only: Viewer
requires an active target project and refuses the change while a dataset is
trashed/finalizing, has an active operation or lifecycle mutation, or has any
non-archived task. Reassociation never moves or rewrites the immutable manifest,
source files, root alias, or storage path.

Bounded project/task storage endpoints separate immutable dataset bytes from
managed model-output bytes. The output catalog is cursor-paged and reports its
aggregate count and bytes. A managed output can be archived, then moved to
recoverable 14-day trash; restore uses the common trash endpoint and permanent
purge remains owner-only with the stable model-version ID typed for confirmation.
Viewer rejects lifecycle changes while processing, publication, a share/session,
or a non-managed layout still depends on the output.

Dataset finalize and server-import adoption return `202` with canonical
`Location: /api/v1/operations/:id` and `Retry-After: 2`. Ops stores only the
non-secret operation ID/type/dataset/upload identifiers in a bounded seven-day
browser checkpoint, polls the subject-bound operation every two seconds, caps
retry backoff at ten seconds, and resumes after reload without retaining bearer,
upload, or preview tokens. Same idempotency key plus exact request bytes replays
the same operation; a conflicting request returns `409`. Closing the page or
stopping status checks never cancels server work. Success is accepted only when
the terminal result contains the expected finalized dataset; terminal failures
surface their sanitized code/message and remain recoverable for review.

Before the first mutation byte is sent, Ops also stores a bounded,
credential-free receipt locator containing only the idempotency key, exact API
path, operation type, expected public IDs, and timestamp. It never stores the
request body, request hash, headers, upload token, preview token, grant, or
bearer. After an interrupted response or a new administrative session, Ops uses
`GET /api/v1/operation-receipts/:key` to recover the atomically linked operation;
it validates subject, method, path, key, request-hash shape, operation ID/type,
and expected dataset/upload IDs before creating the normal checkpoint. A
Viewer-confirmed `404` removes the locator, an unlinked reservation remains
visible as reconciling, and network or contract ambiguity fails closed without
discarding recovery state. The Processing UI exposes an explicit **Recover
accepted requests** action after reload.

Import preview exposes one normalized public storage preflight DTO:
`destinationSpace.{availableBytes,totalBytes,reserveBytes,requiredBytes,sufficient}`.
Operations enables confirmation only when `sufficient` is true and displays the
same byte values reviewed by the operator; internal Viewer storage field names
must not leak across this API boundary.

## Reverse callback and notifications

Viewer posts at most 16 KiB of exact JSON to `https://incoming.ledgetopdroneservices.com/api/viewer/events` with `X-LTDS-Viewer-Key-Id`, timestamp, nonce, content hash, signature, and `Idempotency-Key=eventId`. Operations verifies the selected current/previous rotation key, time window, nonce syntax, body hash, and HMAC before parsing JSON. The same exact Incoming origin and signature protocol protects `/api/viewer/source-authorizations/introspect`; neither machine route is accepted on the Access-protected staff origin.

A ready-for-review callback carries exactly
`PUBLIC_BASE_URL/operations/processing?attemptId=<opaque-id>`. Operations
requires HTTPS, its configured public origin, the exact path, one canonical
`attemptId` query matching the signed event, and no credentials, extra query,
or fragment. Viewer-origin review links and open redirects are rejected.

An operator with `viewer.processing.publish` reviews an unpublished output by
asking Viewer directly for a subject-scoped, short-lived review grant at
`POST /api/v1/attempts/:attemptId/review-sessions`. Operations accepts the
grant only when its attempt, model, immutable version, Viewer origin, exact
`/session/:grant` embed URL, redemption URL, TTL, and derivative allowlist all
match the selected ready-for-review attempt. Renewal uses the mounted
`ViewerEmbed` message protocol so camera and layer state survive transient
authorization failures. Closing the embed calls the matching subject-scoped
`DELETE`; publishing, cancelling, or changing the bound attempt/version also
invalidates Viewer review access. Review authorization never publishes a model,
creates a public share, or exposes raw dataset/provider assets.

Nonce consumption, event fingerprint, outbox row, and audit event are committed in one D1 batch. Same event ID/body replays; same ID/different body or reused nonce/new ID returns `409`. Only expired nonces are pruned. At the live nonce cap, callbacks backpressure instead of evicting unexpired replay protection.

Notifications use the durable Operations outbox and bounded retry. Direct `waitUntil()` email is not the delivery guarantee. Callback errors are sanitized and target `requestedBySubject` when it names an active staff member, with the configured alert address as fallback.

## Public and browser protections

- Public shares support a bounded expiry or explicit `null` (never expires). The UI requires a separate confirmation for never-expiring links. Revocation, expiry, silent renewal, and Viewer state-preservation behavior remain unchanged.
- Public share/access-code, asset, grant-redemption, and administrative endpoints require separate IP/subject/token-derived rate-limit buckets. Do not use attacker-controlled strings directly as limiter keys.
- Operations CSP `connect-src` and `frame-src` enumerate only the exact production/staging Viewer origins. Viewer CORS permits only exact Operations origins and required methods/headers, and exposes `Location, Retry-After` on operation starts and idempotent replays; never use credentialed wildcard CORS.
- Direct asset responses should use byte ranges, immutable versioned cache keys, safe content types, `nosniff`, and download disposition where appropriate.

## Required configuration

Non-secret vars: canonical HTTPS Operations `PUBLIC_BASE_URL`, `VIEWER_PROCESSING_ENABLED`, `VIEWER_BASE_URL`, `VIEWER_SERVICE_KEY_ID`, `VIEWER_EVENT_KEY_ID`, optional previous event key ID, and `DEFAULT_UNITS=imperial`.

Secrets: `VIEWER_SERVICE_HMAC_SECRET`, `VIEWER_EVENT_HMAC_SECRET`, and during overlap only `VIEWER_EVENT_PREVIOUS_HMAC_SECRET`. Never commit, return, or log them. Rotation removes the previous key only after the maximum callback retry/time window has elapsed.

The cross-service golden fixtures are `packages/shared/test-fixtures/viewer-processing-contract-v1.json` and `viewer-processing-route-responses-v1.json`. Both repositories must verify the exact bytes and JSON field names independently.

## Production gate

Required evidence includes migration replay, generated Worker types, full unit/type/build suites, signature/replay/rotation/conflict tests, allow/deny permission tests, upload retry/cancel/resume tests, actual-disk preflight, restart/reconciliation, sanitized log retention, provider failure while published viewing remains healthy, responsive desktop/mobile/keyboard browser tests, direct network-path proof, and callback outbox delivery. Repository code does not prove DNS, secrets, D1, storage mounts, provider reachability, or deployed CORS/rate-limit policy.
