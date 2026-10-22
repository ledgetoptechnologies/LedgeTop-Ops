# Operations / Viewer silent renewal handoff — September 29, 2026

## Current integration checkpoint (supersedes the initial investigation below)

Operations draft PR #138, inspected at `68ca140`, implements the credentialed
challenge/grant transport. Viewer already has its caller in
`workspace-renewal-transport.mjs`, invoked by
`WorkspaceSessionRenewal.requestBackground` in `workspace-renewal.mjs`. Opening
the workspace wires that coordinator from `workspace-projects.js`. Please do not
treat the Viewer caller as missing solely because it lives in a separate repo.

Cross-repository inspection found a contract drift: Operations now requires and
echoes `sessionId`; Viewer previously omitted it and required a response without
that field. Viewer now sends its current session ID and checks the exact echoed
value before accepting a grant. It remains only a correlation hint. The Viewer
bearer is sent solely to Viewer's redemption endpoint, never to Operations.

The agreed browser contract is:

- Credentialed, no-store `GET /api/viewer/workspace/session-renewal/challenge`
  returns exactly `{protocolVersion:1, challenge, expiresAt}`.
- Credentialed `POST /api/viewer/workspace/session-renewal` sends exactly
  `{protocolVersion:1, requestId, sessionId, subject}` with `X-CSRF-Token` from
  the challenge and `Idempotency-Key` equal to `requestId`.
- Successful JSON response contains exactly `protocolVersion`, `requestId`,
  `sessionId`, `grant`, `grantExpiresAt`, `sessionTtlSeconds`, and `redeemUrl`.
  Viewer checks correlation and its exact redemption origin/path.
- Operations authenticates current Access identity and staff binding and
  computes permissions/authorization lifetime on every issuance. Viewer redeems
  into its existing session and verifies the unchanged subject, ID and bearer.

Operations currently gates this handler to `ENVIRONMENT === staging`, as well
as `VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED === true` and processing integration.
Staging must configure the Viewer service/origin and allow the credentialed
challenge/preflight/POST through Access. Live production renewal cannot work
through this endpoint until Operations performs its controlled production rollout.
That change belongs to the Operations agent; no Operations files were changed by
the Viewer agent. Keep the strict auth/CSRF/origin checks for every environment.

Live acceptance remains outstanding: staged API availability, exact request and
response contract, no-opener renewal after real expiry while retaining selected
photos/draft/camera/edit state, and genuinely signed-out recovery. Historical
green checks in either repo are not proof of this browser path.

## Scope and confirmed gap

Implement background renewal for a valid Operations login without navigating or rebuilding the working Viewer tab. Preserve selected File objects, upload state, task drafts, camera/view, and measurement edits. This does not authorize extending an expired/revoked Operations login or modifying unrelated Operations behavior.

Current Viewer evidence:

- `workspace-projects.js` captures `window.opener` as its only Operations controller. `workspace-renewal.mjs` schedules proactive grant requests only when that controller exists. Direct/bookmarked/noopener launches cannot silently renew with the current transport.
- `workspace-recovery.mjs` preserves the original workspace and pauses requests but immediately shows a sign-in dialog. A user click opens `/viewer/reauthorize?state=<nonce>`; the returned Viewer relay redeems a fresh grant in the original tab. This fallback is not invisible background renewal.
- `workspace-projects.js` routes both API calls and task photo chunks through `workspaceFetch`. The local September 29 changes now wait up to 25 seconds for an authority-backed renewal before falling back to recovery, coalescing with an existing renewal and replaying the request at most once. They preserve upload body and idempotency headers. This addresses the racing-401 path, not the missing no-opener transport. Deployment and live verification remain pending.
- `review-session-controller.mjs` brokers model grants using the authenticated workspace. Model renewal therefore depends on workspace renewal, not just a live model tab.

These observations are source-based. Current deployed Operations transport/cookie/Access behavior still needs inspection and live verification. Older handoffs describing a working-tab navigation fallback are superseded by the current in-place recovery implementation above.

## Existing authority exchange (retain)

Operations issues a fresh one-use admin grant to Viewer through the signed service endpoint `POST /api/v1/admin-grants`. The Viewer browser redeems it using `POST /api/v1/admin-sessions/redeem` with JSON `{ "grant": "..." }` and its existing `Authorization: Bearer ...` header.

Viewer accepts an expired but unrevoked existing bearer only for this fresh-grant exchange. Grant subject must equal existing session subject. The exchange keeps the bearer/session identity, replaces permissions and units from the fresh authority, and caps expiry to the earlier of Operations authorization expiry and the configured Viewer session lifetime. Invalid/revoked bearer is rejected; expired bearer alone never renews anything. `test/workspace-renewal-api.test.js` covers expired-session revival and identity preservation.

Current envelope: `{ accessToken?, session: { id, subject, permissions, displayUnits, expiresAt }, controllerOrigin, units }`. Viewer pins exact HTTPS controller origin, subject, session ID, and unchanged bearer during renewal.

Existing opener protocol uses exact-key messages, each with `version: 1`:

| Direction | Type | Remaining keys |
| --- | --- | --- |
| Viewer → Ops | `ltds-viewer:workspace-ready` | `sessionId`, `subject`, `expiresAt` |
| Viewer → Ops | `ltds-viewer:workspace-session-expiring` | `requestId`, `sessionId`, `subject`, `expiresAt` |
| Ops → Viewer | `ltds-viewer:renew-workspace-session` | `requestId`, `grant` |
| Ops → Viewer | `ltds-viewer:workspace-session-renewal-failed` | `requestId`, `retryable` |
| Viewer → Ops | `ltds-viewer:workspace-session-renewed` | `requestId`, `sessionId`, `subject`, `expiresAt` |

The negative response is documented by the existing integration handoff but current Viewer `WorkspaceSessionRenewal.handleMessage` consumes only positive grant messages. Coordinate its handling; do not assume denial classification already works.

## Required no-opener transport

Agree on a concrete supported transport with the Operations owner before coding against a guessed endpoint. Options include an explicit credentialed cross-origin grant endpoint or a deliberately designed authenticated Operations broker. Neither is established as available by this audit. Do not silently embed an interactive login page, use an arbitrary iframe, or open background popups subject to browser blocking.

Required properties:

1. Works when the original opener is absent, closed, reloaded, or navigated elsewhere; routine success does not open a visible tab or modal.
2. Operations validates its current authenticated identity, active staff/account state, allowed Viewer deployment, effective permissions, and authorization expiry on every issuance. Requested subject/session identifiers are correlation hints, never authentication.
3. Correlate responses to a fresh unpredictable nonce/request ID and expected Viewer session/subject/deployment. For messaging, validate exact origin AND source window; target exact origins, never `*`. Reject stale, duplicate, wrong-account, and malformed replies.
4. Retain server HMAC, one-use grants, replay protection, rate limits, short grant lifetime, bounded response sizes/deadlines, and no-store responses. Never expose service secrets, persist grants in browser storage, or log tokens.
5. Credentialed cross-origin fetch requires exact-origin CORS, explicit CSRF defenses, compatible cookie/Cloudflare Access policy, and no unnoticed login redirects/HTML responses. Prove the deployed browser path works; server-to-server access does not prove this.
6. Distinguish `renewed`, authoritative `sign-in-required`/revocation/scope denial, and transient transport/offline failures. Do not label a timeout as proof that the user must log in. Preserve work during failures, but stop protected requests once authorization expires.
7. Successful renewal resumes the same in-memory workspace and model controller channels. No `location.reload`, navigation, form remount, selected-file reset, or camera reset. A genuine sign-in fallback may use a separate tab while keeping the working tab intact.
8. Do not automatically retry task creation or arbitrary non-idempotent writes. Preserve existing idempotency keys and chunk identity for eligible bounded request replay.

## Viewer-side changes to coordinate

- Add a single-flight `ensureFreshAuthorization`/renewal-wait primitive shared by timer, focus/pageshow, API 401 handling, and upload chunks. At known expiry, wait for the bounded authenticated renewal attempt before showing interactive recovery; do not dispose it because one concurrent request returned 401.
- Consume correlated negative Ops responses with explicit terminal versus retryable classification. Reject extra keys/foreign source/wrong request ID, and prevent stale negatives from cancelling an active grant redemption or a newer authority generation.
- Add the agreed no-opener grant transport as an injectable alternative to opener messaging, keeping the existing fresh-grant redemption and envelope checks.
- Keep genuine revocation fail-closed. Preserve recoverable draft state separately from authorization; do not continue protected fetches merely to avoid a dialog.
- Model grant issuance should wait for workspace renewal rather than converting a renewable workspace expiry into permanent model-channel denial. Existing restored same-subject controller contexts should remain non-secret routing hints only.

## Acceptance evidence

Automated tests should cover no opener; closed/reloaded opener; concurrent timer/focus/API/upload expiry; a late 401 from an older envelope; single-flight redemption; slow body parsing; offline then reconnect; sleep beyond expiry; negative-message correlation; actual Ops logout/revocation/subject switch; exact model/version binding; bounded replay and unchanged idempotency keys; no grants/tokens in logs or continuity storage.

Live integration verification must use a safe test dataset/account and demonstrate renewal beyond a real session lifetime with a retained task draft, selected photos (no live processing submission needed), open model camera position, and unfinished measurement edit. Confirm no visible dialog/navigation for a still-valid Ops login. Separately confirm expired/revoked Ops authentication cannot renew and that deliberate sign-in recovers the same-subject workspace without discarding work. Do not interrupt a production upload/job to test expiry.

Report implementation, deployment, and live verification separately. The Viewer-only race fixes do not establish completion of silent no-opener renewal until the Operations transport is implemented and tested end to end.
