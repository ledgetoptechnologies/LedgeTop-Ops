# Operations client access: post-restart diagnostic handoff

## September 30 follow-up, approximately 11:12 AM Central

Viewer health identified `9ad97c22ee315430f0312334608988ed75e47160`, schema 38,
at 11:10 AM Central. This revision includes the proxy diagnostics described below.
A fresh read-only task Internal client lookup failed at approximately 11:11:57 AM
Central. The existing UI still hides its status/code; the root cause remains unknown.
Check Viewer API stderr/stdout for `[client-grant-proxy]` and nginx access logs for
the local GET between 11:11 and 11:13 AM Central. A missing proxy record alone does
not establish whether the request was denied locally or logs were unavailable.

The next UI patch displays only an HTTP status, allowlisted safe error code and
validated UUID correlation reference. It never displays arbitrary upstream bodies,
URLs or credentials. If no reference is returned, the panel explicitly says this
does not identify the failure stage. Authentication and permission enforcement,
stale-result guards and independent public-link form data remain unchanged.
This UI patch is not deployed merely because the earlier diagnostic revision is.

Read-only live preset inspection confirmed enabled native enum controls and typed
defaults after opening Cluster and refreshing capabilities. The preset editor was
closed without saving; no client grant, share, preset or processing job was mutated.

## September 30 follow-up, approximately 06:29 AM Central

Viewer health now identifies deployed revision
`f4dc364de49da12513fd1fde1974d29266e75089`, schema 38. The public temporary
measurement notice is visible. Operations recovery restored the existing workspace
without a manual workspace reload, but reopening task Share still fails to load
Internal client access. This recovery action is not silent-renewal acceptance.

Hermes found one corresponding upstream proxy URL at September 30 02:40 UTC
(September 29 09:40 PM Central), without a recorded status or error code; no
matching output-share request was found in that window. That evidence does not
identify a root cause or establish that no request occurred elsewhere.

The diagnostic follow-up adds failure-only `[client-grant-proxy]` JSON records
with fixed fields: event, timestamp, generated requestId, action, stage,
upstreamStatus, local status, and local code. No URL, employee identity, client
data, response body, signature, token, cookie, or exception text is logged.
`X-LTDS-Client-Access-Request` echoes the generated correlation ID. No ID is
accepted from an incoming request. The records do not alter authorization,
request signatures, timeouts, response status mapping, or error bodies.

After that diagnostic image is deployed, reproduce a read-only Internal client
lookup and collect its failure record from the Viewer API container logs.
`upstream_rejection` with an upstream status proves a rejected upstream response;
`request` with null upstream status indicates no response was obtained;
`response_json`/`response_schema` distinguishes invalid JSON/snapshot handling.
Do not treat these stages as proof of the upstream configuration or reason.
If no record is present, check local authorization/access logs: the proxy does
not log failures that were rejected by middleware before reaching it.
At that earlier checkpoint the diagnostic was pending release and absent from
`f4dc364`; it is now deployed in `9ad97c2` as noted above.

## Observed state

After nginx recovered on September 30 (approximately 04:17–04:19 UTC), a fresh
Operations page launched an authenticated Viewer workspace successfully. Viewer
health identified revision `9b2a6d790afbf2c790be356c23d8bb78180607af`, schema 38.
Hickory Grove task sharing defaults to Internal client, but its panel reports:

> Operations client access could not be loaded. Close and reopen Share to retry.

The Public link panel now loads normally. The existing link's Copy action reported
`Link copied`; Open loaded the public model; Edit settings displayed the stored
password, expiry, views and features. No link settings, client grants or saved
client measurements were changed. A page-only public distance cleared on reload.

This is not the earlier public-share creation/owner-permission issue. It is also
not proof that the same nginx outage caused the remaining client-access failure.
The visible error does not identify its HTTP status or root cause.

## Exact request contract

Viewer's `server/clientGrantProxy.js` implements:

- Local authenticated GET `/api/v1/workspace/client-grants`.
- Required local permission: `viewer.client_grants.manage`.
- Server-to-server POST `/api/viewer/workspace/client-grants` to the configured
  Operations automation origin, using the existing Viewer event signature.
- Read-only JSON envelope: `{ "subject": "ops:<staff ID>", "action": "list" }`.
- Successful snapshot requires `grants`, `projects` and `associations` arrays.

The proxy does not forward a browser bearer to Operations. Do not retrieve or
share browser credentials to reproduce this request.

The inspected Operations source at
`apps/operations/src/worker/viewer-processing.ts` gates the remote route on
`viewerIntegrationEnabled(env)` and `CLIENT_VIEWER_SESSION_ISSUER_ENABLED=true`.
It verifies the machine signature, rate limit, nonce and active staff subject.
`listViewerClientGrantWorkspace` in `viewer-integration.ts` additionally requires
the canonical `viewer.manage` authority and reads current client/project/model
associations. These are source-code findings, not evidence of deployed flag values
or a permission denial for this user.

## Read-only checks requested

1. Find the fresh local GET in Viewer request/error logs. Return timestamp, HTTP
   status and safe error code; do not include Authorization headers, cookies,
   machine-signature headers, event secrets or bearer URLs.
2. If the local request reached the proxy, correlate the remote Operations POST.
   Report its status and safe error category: route disabled/not deployed,
   machine signature rejected, staff identity/authority denied, rate limited,
   invalid snapshot, or database/service failure. Do not guess from the UI text.
3. Confirm the deployed Operations revision and whether its integration and
   session-issuer gates are intentionally enabled for client access. Do not
   enable flags or broaden permissions as a diagnostic workaround.
4. If authority is denied, test effective protected-owner permissions on both
   sides using trusted server identity. Ordinary staff/client restrictions must
   remain unchanged; never infer owner authority from a browser label or email.
5. If successful, verify a bounded snapshot with all three array fields. An empty
   authorized list should render an empty state, not a generic load failure.

Viewer maps rejected upstream requests to `operations_request_failed` and
transport/invalid-response failures to `operations_unavailable`; a 5xx upstream
response maps to local 502. Those codes alone cannot identify the upstream cause.

## Acceptance and coordination boundary

After the responsible fix or configuration rollout, open a fresh workspace from
Operations and inspect Internal client sharing for both a project and a task.
Reading existing clients/grants requires no new grant, public exposure or job.
Test grant mutations only with explicit authorization and a designated fixture.
Keep Operations silent-renewal deployment as a separate, user-deferred check.

This handoff does not authorize cross-agent messaging, credential disclosure,
production role changes, flag changes, or unrelated Operations edits. The user
can forward it to Hermes or the Operations agent.
