# Project Alpha portal projection activation

This is the production operator runbook for the Project Alpha hierarchy
projection received by `ltds-clients`. It does not authorize a deployment or a
flag, secret, Access, DNS, or producer change. Record every readback and obtain
the normal production approvals before performing a write.

## Fixed boundary

- The only machine base URL is
  `https://portal.ledgetopdroneservices.com`; the primary route is
  `POST /api/internal/project-alpha/portal-v2` and registered-source routes are
  under the same `/api/internal/project-alpha/*` prefix.
- The path-specific Cloudflare Access service application covers exactly
  `portal.ledgetopdroneservices.com/api/internal/project-alpha/*`. Its Service
  Auth policy may contain the existing Project Alpha Ops Sync service-token
  identity, but the application and audience are portal-specific. It has no
  human or browser policy.
- `client.ledgetopdroneservices.com` is a legacy browser/public-share/session
  compatibility origin. It is never a machine projection endpoint. The Worker
  returns 404 for `/api/internal/*` on that origin even if edge admission is
  broader than intended.
- The current HMAC secret and Access service-token secret stay server-side.
  Never print, export, paste into evidence, or pass them on a command line.

The receiver needs these non-secret values:

```text
PROJECT_ALPHA_PORTAL_APPLICATION_KEY
PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN
PROJECT_ALPHA_PORTAL_ACCESS_AUD
PROJECT_ALPHA_PORTAL_HMAC_KEY_ID
PROJECT_ALPHA_PORTAL_SYNC_ENABLED
```

`PROJECT_ALPHA_PORTAL_HMAC_SECRET` is the required 32-or-more-byte secret. The
`PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID` and
`PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET` pair is optional and valid only for
a bounded rotation overlap. Neither half is configured by itself, the previous
ID differs from the current ID, and no previous pair is created for an initial
activation.

The checked-in production configuration is the receiver-only state: portal
sync and schema-v3 relation ingestion are true, while client hierarchy reads,
automatic identity eligibility, content grants, requests, notifications,
membership management, invitations, and delegated sharing remain false.
`npm run deploy` is the only supported production release command. Its
repository-owned wrapper executes `deploy:preflight` first and refuses to deploy
unless the remote Worker secret inventory contains the current HMAC secret. A
direct Wrangler invocation bypasses this gate and is not an approved release
path. Cloudflare does not expose secret values for readback, so the Worker independently rejects
a missing, short, oversized, control-character-containing, or whitespace-padded
value with HTTP 503 `portal-receiver-misconfigured` and a redacted structured
reason before Access verification, body reads, or D1 access. Do not enable the
producer after that response; correct the secret and redeploy.

## Runtime gates

| Gate | Activation role | Required base-projection state |
| --- | --- | --- |
| `PROJECT_ALPHA_PORTAL_SYNC_ENABLED` | Hard ingress gate. Any value other than exact `true` returns 404 before body read or D1 access. | `false`, then `true` only for ingest activation |
| `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED` | Schema-v3 parser/storage gate and relation-aware runtime gate. Project Alpha's schema-v3 deliveries are rejected while false. | `true` before the first producer delivery |
| `CLIENT_PORTAL_HIERARCHY_V2_ENABLED` | Independent client authorization/read cutover. It does not control receiver parsing. | `false` through shadow verification; enabled last |
| `PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED` | Separate service-assignment inbox. | `false` |
| `CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED` | Separate downstream request-narrowing policy. | `false` |

The base hierarchy rollout does not activate service assignments, invitation or
membership management, automated identity eligibility, deny-policy management,
or any other client feature gate.

Migration `0190_portal_contact_assignments_v4.sql` is a dormant, receiver-first
schema extension. It leaves the v2/v3 authority tables and lifecycle triggers
unchanged and adds separate v4 marker and contact-assignment tables. Applying
the migration does not authorize Project Alpha to emit schema v4 and does not
enable a contact-role read adapter. A v4 producer requires its own reviewed
activation plan and matching fixtures after rebasing onto the latest Project
Alpha `main`.

## Preflight: no writes

Stop at the first failed check. Save redacted command output with timestamps;
never save secret values or complete authentication headers.

1. Identify the reviewed commit and Worker artifact/version intended for
   deployment. Confirm the worktree is clean and the artifact is built from that
   exact commit. Record the currently active Worker version for rollback.
2. Run the Client typecheck and focused projection, origin-policy, and Worker
   tests against that exact artifact. Confirm the shared schema-v2 and schema-v3
   fixtures pass unchanged in both repositories.
3. Run `npx.cmd wrangler d1 migrations list client-data --remote` from
   `apps/client`. It must report no pending migrations for the reviewed artifact,
   including `0121_client_workspace_hierarchy_v2.sql`,
   `0125_project_alpha_portal_projection.sql`, and
   `0129_portal_hierarchy_relations.sql`. If the deployed receiver contains the
   dormant v4 extension, also confirm
   `0190_portal_contact_assignments_v4.sql` is applied. Do not activate against a partially
   migrated database and do not roll migrations back.
4. Read back Worker custom domains/routes. Confirm the canonical
   `portal.ledgetopdroneservices.com` custom domain reaches `ltds-clients`, the
   legacy `client.ledgetopdroneservices.com` compatibility domain still reaches
   the same Worker, and no unrelated hostname routes to the internal namespace.
5. Read back the path-specific Access application, its Service Auth policy, and
   its audience. Confirm the path is exactly
   `portal.ledgetopdroneservices.com/api/internal/project-alpha/*`, the audience
   equals `PROJECT_ALPHA_PORTAL_ACCESS_AUD`, only the approved machine identity
   is admitted, and no browser/human policy is present. Confirm the Ops Sync
   Access application and audience are unchanged.
6. Check configuration by name and presence only. Confirm all five non-secret
   values above are non-empty and exact; confirm the current HMAC secret exists
   without reading it. If rotation is planned, confirm both previous values are
   present and internally paired; otherwise confirm both are absent. Confirm the
   two service-assignment flags remain false.
   From `apps/client`, run `npm run deploy:preflight`. It calls
   `wrangler secret list --format json`, validates only secret names, and prints
   no secret values. A missing current secret, an orphaned previous secret, or
   any adjacent client-authority/workflow flag that is not exactly false fails
   the preflight.
7. Confirm the receiver-only version has all projection configuration present
   with `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true`,
   `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true`, and
   `CLIENT_PORTAL_HIERARCHY_V2_ENABLED=false`. Confirm every adjacent flag
   enumerated by the preflight remains false.
8. Before activating this version, probe the currently deployed false state
   without sensitive logging:
   - missing or invalid Service Token at the canonical endpoint is denied by
     Access and never reaches the Worker;
   - a valid Service Token at the canonical endpoint receives Worker 404 because
     ingress is false;
   - `/api/internal/project-alpha/portal-v2` on the legacy origin receives
     Worker 404 if it reaches the Worker and never receives a projection-handler
     response; and
   - an existing legacy public share loads, and its same-origin session request
     remains admitted. Do not include share fragments or cookies in evidence.

## Ingest-only activation

Each numbered state is a separately reviewed Worker version. Do not edit live
variables in place and do not enable the Project Alpha producer before step 4.

1. Preserve the preflight version and evidence. Run `npm run deploy:preflight` against
   the reviewed ingest-only configuration. It must confirm the remote current
   secret name exists, both ingest flags are true, and all adjacent authority
   and workflow flags remain false. Confirm the release diff contains no
   unrelated configuration change.
2. Activate that version on `ltds-clients` and read it back. Repeat the legacy
   internal 404 and legacy public-share/session checks before sending a valid
   projection.
3. At the canonical route, prove missing/wrong Access or HMAC material, an
   unknown key ID, stale timestamp, wrong application key, changed body digest,
   wrong delivery ID, and invalid schema are rejected with no receipt,
   checkpoint, or active-generation change. Access/signature/key/timestamp
   failures return 401 after Access admission; application/body/envelope failures
   return 422; sequence/generation conflicts return 409.
4. Authorize Project Alpha separately to use its canonical server-only base URL
   and schema-v3 contract. Send one bounded staging-equivalent production
   preflight delivery, then reconcile one pilot workspace. Do not disclose
   Service Token or HMAC material in tickets, commands, logs, or screenshots.
5. Verify every `snapshot.page` receipt and contiguous page count while the old
   active generation remains visible. Send `snapshot.activate` only after page
   count, record count, snapshot hash, root, relation, lifecycle, principal, and
   entitlement checks agree. Confirm the checkpoint changes atomically and the
   prior generation was visible until activation.
6. Verify an identical retry is acknowledged, a delivery-ID payload mismatch is
   rejected, sequence gaps and stale generations return 409, and tombstones
   immediately remove affected authority. Record receipt/checkpoint identifiers,
   counts, and timestamps, but not payloads containing personal data.
7. Keep `CLIENT_PORTAL_HIERARCHY_V2_ENABLED=false` during the observation window.
   Validate parity, staleness alerts, workspace containment, deny precedence,
   completed-project lifecycle behavior, and the selected pilot's explicit LTDS
   identity binding and membership.
8. Only after a separate authorization review, activate a new version with
   `CLIENT_PORTAL_HIERARCHY_V2_ENABLED=true` for the approved pilot. Do not infer
   membership from a projected contact, email match, primary-contact marker, or
   Project Alpha entitlement alone. Expand only through separately approved
   versions with recorded denial and rollback tests.

## Drain-first rollback

Rollback must preserve producer/receiver contract compatibility long enough to
revoke projected authority. A code rollback never reverses D1 migrations or
deletes evidence.

1. On unexpected client authorization, immediately activate the recorded
   ingest-only version with `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true`,
   `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true`, and
   `CLIENT_PORTAL_HIERARCHY_V2_ENABLED=false`. Preserve request IDs, logs,
   active/prior Worker version IDs, Access/DNS readbacks, receipts, checkpoints,
   and D1 evidence.
2. Keep `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true` and
   `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true`; keep the canonical Access
   application/audience and current signing key available. During a planned key
   rotation, keep the valid previous pair available as well. This allows queued
   revocation/tombstone deliveries to authenticate and parse.
3. Coordinate a producer stop, then drain already queued ordered deliveries and
   required tombstones. Confirm their receipts are complete, checkpoints are
   contiguous, and no pending delivery still depends on the current or previous
   key. Do not delete projection rows or D1 audit evidence.
4. Only after the producer is stopped and the drain is acknowledged, activate a
   reviewed receiver version with `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=false`.
   The relation flag may return to false only after no schema-v3 delivery can
   arrive. Retire previous-key material only after the same proof. Access/DNS
   retirement is a separately approved final step, never the first rollback
   action.
5. Re-probe canonical false-state behavior, legacy internal 404, legacy public
   shares and same-origin sessions, Delivery health, and the final Worker/Access/
   flag state. Record the final state and the forward-fix owner.

If the receiver cannot remain contract-compatible for the drain, stop the
producer first, preserve all pending records and credentials, and escalate. Do
not force a flag-off state that strands revocations or retire the audience or
signing keys while Project Alpha can still retry.
