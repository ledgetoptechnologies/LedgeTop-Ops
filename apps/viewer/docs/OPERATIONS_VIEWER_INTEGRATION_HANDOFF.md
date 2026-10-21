# Operations / Viewer integration implementation handoff

> Updated read-only Operations assessment and measurement integration assignment: [September 5 handoff](OPERATIONS_MEASUREMENTS_RELEASE_HANDOFF_2026-09-05.md). Use its newer pinned Operations findings where this historical snapshot differs.

## Status, ownership, and revision boundaries

Prepared for the user's separate, long-running **Operations implementation agent**. The user wants that agent to implement the Operations integration while the Viewer agent releases the current Viewer work. This document does not authorize changing live credentials, broadening client access, or bypassing authentication.

- Viewer baseline: `6e900dd`. This document describes the Viewer release changes after that baseline. Identify its source revision with `git log -1 --format=%H -- docs/OPERATIONS_VIEWER_INTEGRATION_HANDOFF.md`; use the verified image reference supplied alongside the release, not the baseline image. The commit containing this handoff is the contract snapshot; no self-referential release SHA is embedded here.
- Operations inspected read-only: `7efd2aaa02ce9149c4a46641ded0ec39e6fa7157`, via `refs/remotes/origin/main` in `C:/Projects/LTDS-Ops`. Its working checkout was older and was neither switched nor edited.
- **Your Operations task may already be ahead of that revision.** First reconcile these findings with your current branch and unfinished changes. Do not reset, overwrite, or duplicate existing implementation based on this snapshot.
- Existing endpoints below are identified explicitly. Design requirements/proposed transports are not claims that an endpoint exists. Agree any new Viewer-facing contract with the Viewer owner before depending on it.
- No live sessions, bearer tokens, grants, client identifiers, or production capability URLs are included.

## What the user wants

1. Routine workspace access renewal should happen quietly in the background, including when the original Operations opener is closed or absent. The workspace should not visibly navigate through Operations/sign-in and back while the user is working or idle.
2. Open model tabs should continue renewing without requiring refresh/reopen. Preserve the camera/view and normal interaction while recovery occurs. Real expired/revoked authorization must still fail closed.
3. From a private ready model, staff should be able to give an explicitly selected Operations client access to **that model**, with its exact association and permissions. Creating a public link must not be a prerequisite or hidden side effect. No implicit whole-project/future-task grants.
4. Keep public-link sharing as a separate, deliberate choice. Do not weaken derivative verification or expose raw/private assets to achieve either workflow.

## A. Renewal: verified causes versus unresolved observations

### Verified in source and controller reproductions

- Operations `ViewerDataOverview.openWorkspace()` installs its renewal listener in the opening Operations window. It pins the opened window, Viewer origin, workspace session ID, and subject. An openerless/reloaded/closed-opener workspace has no equivalent proactive grant transport in the inspected implementation.
- Viewer intentionally falls back to top-level Operations `/viewer/reauthorize?state=...` when workspace authorization expires. Operations obtains a new one-time admin grant and uses `location.replace()` back to the Viewer workspace. This explains visible navigation, but not necessarily every appearance of a sign-in screen; actual Operations login/cookie/Access state was not captured for every incident.
- Before this Viewer candidate, model renewal channel records lived only in workspace memory. A workspace reload/reauthorization lost listeners while model tabs retained their random BroadcastChannel names. Posting to an unobserved channel does not itself fail; model renewal then times out/retries.
- Workspace grant redemption previously released its single-flight marker/watchdog before the fetch/body read completed. Repeated focus could overlap requests, and completion after disposal could install stale state. Candidate tests reproduce and address those races.

### Not proven / not solved solely by this release

- The candidate does **not** supply an Operations-authorized silent openerless grant transport.
- Controller tests are not evidence that every real production stall has the same cause. Actual cookie policy, Operations auth refresh, device sleep, network interruption, and long-session behavior need integrated browser testing.
- Hiding the renewal label or lengthening bearer/grant lifetime would not fix the authority/transport boundary.

## B. Existing workspace authorization contract

### Existing issuance and redemption endpoints

| Hop | Existing contract | Important boundary |
| --- | --- | --- |
| Operations browser to Operations | `POST /api/viewer/admin-grant`, valid `Idempotency-Key` | Current authenticated staff principal; processing integration enabled; current global `viewer.view` required. Uses existing Operations request security. |
| Operations server to Viewer | `POST /api/v1/admin-grants` | Existing authenticated HMAC service path; browser cannot call it as an authority substitute. |
| Viewer browser to Viewer | `POST /api/v1/admin-sessions/redeem`, JSON `{ "grant": "<one-time grant>" }` | During renewal presents existing Viewer admin bearer; same subject and session identity must remain pinned. |
| Viewer browser current-session check | `GET /api/v1/admin-sessions/current` | Existing Viewer admin bearer, not a source of fresh Operations authorization. |

Operations issuance constructs `subject: "ops:<staff-id>"`, re-evaluated Viewer permissions, resolved `displayUnits`, and `authorizationExpiresAt`. At the inspected Operations revision the latter is now +30 minutes. Preserve its current policy unless separately reviewed; do not extend it just to suppress redirects. Operations calls `ViewerServiceClient.createAdminGrant()` with these fields and the logical idempotency key.

Viewer service issuance accepts exactly the existing body contract: `subject`, `permissions`, `displayUnits`, `authorizationExpiresAt`. It returns `grant`, `grantExpiresAt`, `redeemUrl`, `sessionTtlSeconds`. Grant expiry is capped by both the authorization deadline and configured grant TTL. Operations augments this with `workspaceUrl` and resolved/default units.

`workspaceUrl` must match the configured HTTPS Viewer origin and `/workspace/<encoded grant>` exactly, without unexpected search/hash components. A reauthorization return adds only the correlated `#reauthorize=<state>` fragment after validating that URL.

Viewer redemption consumes a fresh one-time grant. A presented invalid bearer is rejected, a mismatched subject is rejected, and expiry is capped by the grant's Operations authorization deadline and configured admin-session TTL. With a valid presented bearer, the existing admin session/token is renewed rather than silently exchanging identity. With no bearer, an initial session is created through the initial authorization flow. Do not retry an expired-bearer request without its Authorization header just to evade a rejection.

The workspace response envelope includes `session`, `controllerOrigin`, and `accessToken`. Renewal validation pins `session.id`, `session.subject`, exact HTTPS `controllerOrigin`, and the unchanged bearer; it validates future `session.expiresAt`. Current permissions/units come from the server envelope, never a browser routing descriptor.

### Existing opener postMessage protocol, version 1

These are exact-key messages, not extensible arbitrary objects. Each message includes `version: 1` and the named `type`.

| Direction | Type | Other fields |
| --- | --- | --- |
| Viewer to Operations opener | `ltds-viewer:workspace-ready` | `sessionId`, `subject`, `expiresAt` |
| Viewer to Operations opener | `ltds-viewer:workspace-session-expiring` | `requestId`, `sessionId`, `subject`, `expiresAt` |
| Operations opener to Viewer | `ltds-viewer:renew-workspace-session` | `requestId`, `grant` |
| Operations opener to Viewer | `ltds-viewer:workspace-session-renewal-failed` | `requestId`, `retryable` |
| Viewer to Operations opener, successful redemption | `ltds-viewer:workspace-session-renewed` | `requestId`, `sessionId`, `subject`, `expiresAt` |

Operations checks both `event.source === openedWindow` and `event.origin === configuredViewerOrigin`, pins session/subject from the first valid ready message, and deduplicates request IDs. Replies target that exact Viewer origin. Viewer checks exact source/opener, exact controller origin, request correlation, protocol and grant syntax. Never replace target origins with `*`.

**Existing compatibility gap to reconcile:** Operations sends the negative renewal message above, but the inspected Viewer `WorkspaceSessionRenewal.handleMessage()` consumes the positive `renew-workspace-session` message only. Negative responses currently result in the bounded response timeout rather than immediate terminal/retry classification. If your integration consumes negative responses, coordinate an additive Viewer handler and tests; do not assume the candidate already handles them.

Viewer starts renewal five minutes before expiry and rechecks on focus, visibility, and pageshow. Response/redemption deadlines are 10 seconds; retries are bounded (`2, 5, 15, 30, 60` seconds). The candidate preserves a single in-flight redemption through body parsing, aborts on timeout/disposal, and rejects late generations.

### Workspace navigation state and fallback

Current route state is `{ section, selectedProjectId, expandedTaskId, taskPage }`. Dashboard routes use `section`, `project`, `task`, and optional `panel=gcp|settings|files`; route validation checks project/task relationships against newly loaded authorized data. History/back navigation must keep working.

Fallback reauthorization stores a one-use random state nonce, creation time, and this navigation state in sessionStorage. Return validation requires exact nonce equality and age within five minutes, consumes the record, and restores validated view state. This is routing/CSRF correlation, not authorization. Do not treat its model/project IDs as permission evidence.

The desired silent success path should not navigate/rebuild the workspace, clear an active dialog, discard in-progress form contents, move focus, or tear down model tabs. Full fallback reload currently preserves the route, not every unsaved form or modal state; do not claim that stronger guarantee is already implemented.

## C. Viewer model-channel continuity already in the candidate

`ReviewSessionController` now persists only bounded, non-secret routing descriptors under `ltds-viewer-model-controller-contexts-v1` in the workspace tab's sessionStorage:

```text
{ subject, records: [{ channelId, context, updatedAt }] }
review context: { attemptId, modelId, modelVersionId, sessionTtlSeconds }
published context: { sessionMode: "published", outputId, modelId,
                     modelVersionId, sessionTtlSeconds }
```

- Strict keys, valid channel UUID/context, at most the last 32 records, and at most 24 hours since successful controller activity. This bounds reload continuity, **not** the number of models opened during a live workspace lifetime.
- The new descriptors do not contain bearer/grant values, capability URLs, or permissions. Existing authenticated-session handling is separate.
- Descriptors restore only after the workspace server authenticates the same Operations subject. Subject changes, explicit sign-out, authoritative denial/revocation, and untracking discard applicable routing. Known expiration may retain it through fallback.
- Storage failures cannot block an otherwise valid authenticated install. Failed persistence attempts best-effort remove old metadata; channel creation/advisory failures are isolated.
- A restored channel learns the surviving model's expiry only from a correlated exact-key request for the saved model, within the bounded restoration interval. Browser metadata never creates access: the authenticated server must issue a fresh exact-context grant.
- Channel name: `ltds-viewer-review:<channelId>`. The model uses its existing review-controller routing fragment. This remains Viewer-origin messaging, not an Operations cross-origin replacement transport.
- `ltds-viewer:controller-ready` advisory contains exactly `version`, `type`, `channelId`, `modelId`. A model only accelerates an already-due renewal for its current channel/model, with no current redemption and no authoritative block. Advisory grants no access, does not clear denial, and does not navigate the camera. Older model tabs ignore it and use their existing retry schedule.
- Model expiring request fields: `version`, `type: "ltds-viewer:session-expiring"`, `requestId`, `modelId`, `expiresAt`. Controller response: `version`, `type: "ltds-viewer:renew-session"`, `requestId`, `grant`. Existing ready/renewed/failure acknowledgments must remain correlated; consult the controller tests before changing those handlers.

### Existing exact model grant endpoints

| Context | Endpoint / permission | Required server validation |
| --- | --- | --- |
| Private staff review | `POST /api/v1/attempts/:id/review-sessions`, empty JSON object; `viewer.processing.publish` | Attempt `ready_for_review`, exact result model/version/output/attempt relationship, output `ready`, eligible assets and integrity. |
| Activated published staff view | `POST /api/v1/processing/outputs/:id/view-sessions`, empty JSON object; `viewer.processing.read` | Output `published`, exact current active model version, published eligible assets and integrity. |

Both return one-time UUID `grant`, `grantExpiresAt`, configured `sessionTtlSeconds`, `sessionMode`, `modelId`, `modelVersionId`, `assetKinds`, `redeemUrl`, and `embedUrl`; review also returns `attemptId`. Model redemption uses `/api/v1/sessions/redeem`. The controller validates returned mode/model/version/TTL and review attempt exactly. Published saved `outputId` must equal `modelVersionId`. Do not silently renew a historical tab onto the newest model version.

These staff grants are capped by the current authenticated workspace expiry and Viewer session TTL. Their existing permissions include view/measure/cameras, general downloads off, and the separate camera-photo-download allowance. They are **not** Operations client grants; do not repurpose staff-review tokens for clients.

## D. Required Operations work: supported silent openerless renewal

Implement a transport only after reconciling current Operations authentication and browser constraints. **No new endpoint is specified as existing here.** The present admin-grant route is an authenticated Operations route, not demonstrated as a cross-origin browser credential endpoint.

Required properties:

1. It works when the original opener is missing, closed, or reloaded, without a top-level bounce for a still-valid Operations login.
2. Operations revalidates the current staff identity, permissions, and authorization expiry for every issuance. Disabled staff, denied scope, and revoked sessions fail closed.
3. Bind each request to the expected Viewer deployment origin, current workspace identity/subject, and a fresh correlation value. A caller-supplied subject or continuity descriptor is never sufficient authority.
4. Preserve one-time grants, service HMAC verification, replay protection, bounded deadlines/backoff, and current lifetime caps. Never send Operations cookies or service secrets through the Viewer browser/backend as a shortcut.
5. Any browser credentialed cross-origin design must have explicitly supported exact-origin CORS, CSRF defenses, cookie/Access policy, no-store responses, and no unexpected redirect following. Existing server HMAC access alone does not prove a browser transport is supported.
6. A same-origin Operations broker/popup/message design is another possible approach, but needs an explicit authenticated protocol, origin/source checks and lifecycle policy. Do not silently iframe an interactive sign-in page or rely on ambient login as a bypass. Account for popup blockers and closed-window recovery.
7. Differentiate transient network/transport failure from authoritative authorization denial. Keep valid current rendering usable during a transient failure, but block new protected fetches when authorization actually expires. Do not leave an indefinite "renewing access" state without recovery/action guidance.
8. Across sleep and resume, detect actual expiry before reuse. If full reauthentication is genuinely required, use the existing deliberate fallback with state preservation; do not forge continuity across a different account.
9. Coordinate any additive Viewer message or API handling with the Viewer owner. Operations-only changes cannot make an unsupported Viewer response handler exist.

Choose and document the concrete transport in your implementation report, including why it is compatible with the deployed Operations/Access/cookie environment. Transport feasibility across deployments remains an integration decision, not a source-verified conclusion in this handoff.

Browser references checked for this handoff: [MDN: Window.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage) documents exact target-origin selection and validation of sender origin/source plus message syntax. [MDN: CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) documents that credentialed responses cannot use a wildcard allowed origin and remain subject to browser cookie policy. These constraints support the requirements above; neither reference establishes that this deployment already offers a supported silent transport.

## E. Private ready model -> exact Operations client access

### Current behavior and the missing integration

The Viewer candidate has a separate authenticated-client access section. For an already active published output it selects only a unique Operations association matching that exact model and client project/account. For a private ready output it currently explains that verified activation plus an exact Operations association is not connected; it does **not** create a public link to work around that gap.

Do not confuse three different states:

- Processing output `ready`: staff-reviewable, not activated for delivery.
- Processing output `published` / active model version: selected verified derivative assets activated for delivery. This is not itself the creation of a public bearer URL.
- Public share: a separately created revocable link that may follow the active version. Client-account authorization is another separate mechanism.

Operations catalog models use their own `status: "ready"`, `available`, and `activeVersion` checks. That catalog readiness must not be equated with a private processing output's `ready` status. Use the exact Viewer model/version/attempt relationship, not matching names.

### Existing Viewer activation primitive

`POST /api/v1/attempts/:id/publish` requires `viewer.processing.publish` and body `{ "selectedAssetKinds": [...] }`. It validates a ready-for-review attempt, selected public derivative kinds against eligible assets, and calls the atomic verified publication path. It returns `{ task, model }`; it does not itself create a public share.

This is an existing primitive, **not** an already-complete exact private-client workflow. Before reusing/extending it, add the integration-level safeguards needed for exact output identity, authorization freshness, idempotent response-loss recovery and existing-audience impact. Do not implement a blind sequence of unrelated client-side POSTs.

The separate `POST /api/v1/processing/outputs/:id/shares` path now supports explicit public activation/link creation with `publishIfReady`, `selectedAssetKinds`, `allowExistingAccessUpdate`, `label`, optional `password`/`expiresAt`, `permissions`, and `displayUnits`. It requires publish permission in addition to share creation when activating, verifies assets, and binds receipt-backed publication/link creation atomically. **Do not call this route for private client access**, even if you immediately revoke its link afterward.

Activation can change the content visible through existing model/public/project links or associated clients. The public-share path explicitly detects/acknowledges this. The private activation path must provide equivalent existing-audience analysis/consent or choose a genuinely non-broadening version-pinned design. A whole-project link that includes newly activated tasks is an existing audience too.

### Existing Operations association API

`POST /api/viewer/associations`, authenticated Operations principal with global `viewer.manage`, valid `Idempotency-Key`, strict body:

```json
{ "projectId": "<Operations-client-project-id>", "viewerModelId": "<exact-Viewer-model-id>" }
```

The inspected implementation checks active client project, current Project Alpha source version, and exact available catalog model with active version. It persists association identity, Viewer model version/resource version and project source version. Response includes `association` and `sessionRevocation`, with replay behavior. Refresh/replacement can invalidate old authorizations; preserve its revocation-outbox semantics.

A new UI action must never create an association to a similarly named model, silently rebind an existing unrelated association, or omit source/version checks because the Viewer supplied an ID. Recheck authority and current source state server-side immediately before committing. Decide how a changed active model version should be presented/confirmed rather than silently broadening an existing grant.

### Existing client-grant proxy and payload

Viewer browser: `/api/v1/workspace/client-grants` supports GET/list, POST/create and DELETE/revoke, gated by `viewer.client_grants.manage`. Operations currently maps global `viewer.manage` to that Viewer permission. The Viewer proxy derives `subject` from authenticated `req.adminPrincipal`, never browser JSON.

Viewer server -> Operations: existing signed `POST /api/viewer/workspace/client-grants`. The proxy signs method/path/body with its configured event-signing identity; does not forward the browser bearer/cookies; refuses redirects; bounds request timeout/response size. Operations verifies the service signature, reserves its nonce, applies machine rate limits, resolves the active staff principal, and rechecks permissions.

Envelope fields:

```text
list:   { subject, action: "list" }
create: { subject, action: "create", idempotencyKey, grant }
revoke: { subject, action: "revoke", idempotencyKey, grantId, reason }
```

The browser POST is `{ grant: ... }` with a valid `Idempotency-Key`; DELETE is `{ grantId, reason }` with one too. Revoke reason is nonempty, trimmed, at most 240 characters. Response snapshot contains `projects`, `associations`, `grants`, optionally `replayed` and revocation status. Current bridge requires Viewer integration and `CLIENT_VIEWER_SESSION_ISSUER_ENABLED` on the Operations side.

The exact-model grant must be explicit:

```json
{
  "grant": {
    "accountId": "<authorized-client-account-id>",
    "projectId": "<that-client-project-id>",
    "scopeType": "task",
    "associationId": "<unique-exact-model-association-id>",
    "includeFuturePublished": false,
    "expiresAt": null,
    "permissions": { "measure": true, "cameras": true, "download": false }
  }
}
```

Use a future ISO date instead of null when staff explicitly sets expiry. Operations checks active account/project membership, current association belonging to that project, grant scope, expiry and permissions. `scopeType: "task"` here means the exact model association; it is not a Viewer processing task ID supplied in place of `associationId`.

**Important inspected-schema default:** Operations defaults omitted `includeFuturePublished` to true, then rejects task grants that include future tasks. Always send **false** for exact-model access; do not omit it. Whole-project access requires its own explicit action/consent and must not be a fallback for a missing association.

Operations also has direct authenticated `POST /api/viewer/client-grants` and `DELETE /api/viewer/client-grants/:grantId`, with the same create/revoke authority and logical idempotency requirements. Reuse the shared implementation rather than introducing inconsistent authorization in the workspace bridge.

### Suggested orchestration invariants (implementation required)

1. Staff selects the immutable ready output, eligible derivative kinds and exact client account/project; server resolves its attempt/model/version and current permissions.
2. Inspect existing audiences and require informed confirmation if activation changes what they can see. Reject stale selection/archived task/unverified assets.
3. Activate verified selected delivery assets without creating a public link. Record the exact result/version and logical operation receipt.
4. Create or verify the unique Operations association using current project/model source versions.
5. Grant only the exact association, with `includeFuturePublished: false` and requested permissions. Preserve client-grant idempotency/audit/revocation behavior.
6. Treat the cross-service operation as a durable, resumable sequence: publication and an Operations DB mutation cannot be assumed to share one transaction. On response loss, replay/reconcile the same operation and payload; changed payload under the same key must conflict.
7. Do not roll back a newer activation or revoke an unrelated preexisting grant during compensation. If activation succeeds but association/grant fails, report that precise partial state; do not claim client access is complete or broaden access to finish it.
8. Return success only after verifying the exact association/grant and resulting allowed model/version. Reconcile source changes/revocation before resume; a stored receipt is not permission to resurrect revoked access.

## F. Source map and test ownership

Viewer files (relative to Viewer repository):

- `workspace-renewal.mjs`: opener transport, due scheduling, redemption single-flight, expiry/disposal.
- `review-session-controller.mjs`: exact-context grants, continuity descriptors, correlated channel recovery.
- `workspace-projects.js`: authenticated install/clear, reauthorization state, routes, exact client association selection, share UI.
- `main.js`: model-side renewal, due-only controller-ready advisory; preserve rendering/session lifecycle boundaries.
- `server/processingApi.js`: admin issuance/redemption, review/published sessions, publication and explicit public sharing.
- `server/processingRepository.js`: atomic verified activation, output lifecycle and receipt-backed mutation helpers.
- `server/clientGrantProxy.js`, `server/viewerEvents.js`: existing signed Operations bridge; never copy secrets into documentation/tests.
- `docs/WORKSPACE_RENEWAL_CONTINUITY.md`: focused description of the Viewer candidate's existing guarantees.

Operations files at the inspected revision:

- `apps/operations/src/client/OperationsApp.tsx`: `ViewerDataOverview`, opener protocol and reauthorization return.
- `apps/operations/src/client/viewer-admin-client.ts`: existing admin client.
- `apps/operations/src/worker/viewer-processing.ts`: permissions mapping, admin grant route, signed workspace client-grant route.
- `apps/operations/src/worker/viewer-integration.ts`: association/client-grant schema, create/revoke, current-source checks and revocation handling.
- `packages/shared/src/viewer-service.ts`: signed Viewer service client and response validation.
- `apps/operations/src/worker/request-security.ts` and deployed request/auth middleware: reconcile actual session/CSRF/origin protections before choosing a new transport.

Viewer focused tests to preserve/extend:

```sh
node --test test/workspace-renewal.test.mjs test/workspace-renewal-api.test.js test/workspace-reauthorization.test.js test/review-session-controller.test.mjs test/viewer-session-recovery.test.js
node --test test/workspace-share-api.test.js test/client-grant-proxy.test.js test/project-share-api.test.js test/workspace-task-layout.test.mjs
```

Real-browser harnesses include `test/session-renewal-browser.test.mjs`, `test/workspace-project-browser.test.mjs`, and `test/project-share-browser.test.mjs`; inspect each harness's actual launch prerequisites. Do not call a controller VM test an actual Operations-cookie or GPU/session-lifetime acceptance run.

Operations existing tests worth extending: `viewer-admin-client.test.ts`, `viewer-admin-permissions.test.ts`, `viewer-processing-contract.test.ts`, `viewer-workspace-client-grants.test.ts`, `viewer-session-issuer.test.ts`, `viewer-public-share-routes.test.ts`, and browser `viewer-processing.spec.ts` / `delivery-viewer.spec.ts` under `apps/operations/test`. Use the Operations task's current package scripts/runtime, not an assumed command from this document.

## G. Integrated acceptance matrix

Record both revisions, browser/environment, exact synthetic scenario, expected vs actual state, and sanitized request/status/correlation evidence. Never include grants/bearers or capability URLs in the report.

| Scenario | Required result |
| --- | --- |
| Normal due renewal, opener alive | One logical issuance/redemption, same workspace subject/session identity; no navigation or camera reset. |
| No opener, opener closed, opener reloaded | Supported silent transport succeeds while Operations auth remains valid; no hidden login bypass. |
| Two workspace tabs / several model tabs | Correlation and subjects isolated; each tab renews only its own sessions; no grant stolen/replayed across tabs. |
| Workspace reload / genuine fallback return | Same-subject descriptors restore; old model channels recover without model refresh; route/back state survives. |
| Sleep across lead time and across expiry | Resume checks actual deadlines; recover only through fresh current authorization; no expired protected fetches silently allowed. |
| Duplicate focus/visibility and slow response body | Single-flight maintained through body read; disposed or timed-out responses cannot overwrite current state. |
| Grant issuance success but response lost | Bounded idempotent reconciliation; no unbounded grant storm, duplicate grants/links, or changed-payload replay. |
| One-time grant redeemed but response lost | Explicitly test retry/current-session recovery behavior; consumed grant is not reusable authority. |
| Wrong origin/source/request/version/subject/model | Rejected without session update or information leak; stale controller-ready does not unblock denial. |
| Operations revoked/disabled staff or changed account | Terminal deny, no route metadata treated as authority; existing policy-driven session revocation remains effective. |
| Operations unavailable, valid Viewer session | Preserve valid view; bounded retry/status; expire honestly at the authorization deadline. |
| Auth genuinely expired / interactive login required | Clear explanation/action, safe reauth fallback, same-subject validation; no indefinite renewing state. |
| Storage unavailable / corrupt/old/>32 descriptors | Auth install still succeeds; invalid routes discarded; older non-restored model tabs have bounded understandable recovery. |
| Exact private ready-model client access | Verified activation, exact association and task grant; public-share count unchanged; no project/future-task grant. |
| Two similarly named models, wrong account/project, duplicate association | Fail closed; IDs and current association authority determine access, not labels or arbitrary first match. |
| Existing public/project links or client audiences | Activation impact detected and consented or rejected; no incidental exposure of newly activated content. |
| Unverified/private assets or stale/archived output | Cannot activate or grant through shortcut. Selected public derivatives only. |
| Activation succeeds, association/grant fails | Accurate partial-state report and resumable receipt; no fake success/public-link workaround. |
| Revocation/source-version change during retry | Revalidate; no revoked grant resurrection or rollback of another user's newer operation. |
| Exact grant vs future model/task publication | No added tasks through exact grant; version/association changes follow explicit current-source policy and reauthorization, not silent broadening. |

## H. Rollout, compatibility, rollback and requested return report

1. Reconcile the current Operations branch first. Document any already-implemented transport/contract differences and preserve its work.
2. Land additive contracts behind explicit capability/feature negotiation when required; do not infer support from a 404 and switch to a broader permission flow.
3. Keep current opener protocol v1 and genuine-expiry fallback functional during mixed-version deployment. Current Viewer model tabs lacking the ready advisory still use existing retries.
4. Verify the proposed transport in a non-production environment with real cookie/Access/CSRF behavior, then run the matrix with Church/Rome as visual continuity checks. Rendering benchmarks alone do not test authorization.
5. Enable silent renewal independently of direct-client activation so either can be rolled back. Rollback must restore the known fallback/blocked UI, not weaken expiry or mint public links.
6. Do not delete durable mutation/revocation receipts during rollback. Reconcile partially completed cross-service activation safely. Never undo somebody else's later model activation based only on an old operation result.
7. Before release, supply Viewer owner with required coordinated Viewer changes, exact request/response schemas, permission/feature flags and deployed-version compatibility. No undocumented endpoint guessing.

Please return: actual Operations commit(s), Viewer compatibility range, chosen renewal transport and security rationale, current tests plus real-browser evidence, exact private-client orchestration/partial-failure semantics, migration/feature flag and rollback instructions, and remaining risks. Separate source-verified fixes, synthetic tests, and observed end-to-end production behavior. The user's goal is seamless routine operation with unchanged authorization boundaries, not merely fewer visible warnings.
