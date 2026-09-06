# Project Alpha portal projection activation

This is the production operator runbook for Project Alpha hierarchy events
received by `ltds-ops-sync` and internally projected to `ltds-clients`. It does
not authorize a deployment or a
flag, secret, Access, DNS, or producer change. Record every readback and obtain
the normal production approvals before performing a write.

## Fixed boundary

- Project Alpha has one machine destination:
  `https://ops-sync.ledgetopdroneservices.com`; all outbound integration events
  use `POST /v1/project-alpha/events` through the existing External Operations
  profile.
- The existing Ops Sync Cloudflare Access service application, audience,
  service-token identity, application key, and Project Alpha event HMAC remain
  the only Project Alpha outbound trust boundary. Portal hierarchy, membership,
  entitlement, and revocation updates are event types on that connection.
- Project Alpha wraps each portal delivery in the strict outer integration
  event `event_type: "portal.projection"`. Ops Sync authenticates and records
  that source event, validates the nested envelope, then privately invokes the
  Client Worker's named portal-projection entrypoint.
- `projection_kind` selects the exact inner `portal`, `catalog`, or
  `service_assignments` contract.
- `client.ledgetopdroneservices.com` is a legacy browser/public-share/session
  compatibility origin. It is never a machine projection endpoint. The Worker
  returns 404 for `/api/internal/*` on that origin even if edge admission is
  broader than intended.
- The Project Alpha event HMAC and Access service-token secret stay server-side.
  Never print, export, paste into evidence, or pass them on a command line.

The Client receiver retains the independent ingest flag:

```text
PROJECT_ALPHA_PORTAL_SYNC_ENABLED
```

The Ops Sync service binding and named entrypoint are the private internal trust
boundary. There is no Project Alpha portal base URL, portal key ID, portal HMAC
secret, or portal-specific Access application. Rotation of the existing
External Operations credentials follows the Ops Sync runbook and must preserve
queued event compatibility.

The Client Worker does not mount the former direct portal-v2 HTTP writers.
`PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED` remains exactly `false` as a second
defense if an obsolete handler is accidentally remounted. Existing public
share, download, authenticated portal, and legacy redirect routes are unchanged.

The checked-in production configuration is the reviewed default-on eligibility
state: portal sync, hierarchy reads, automatic identity eligibility, denylist
enforcement, and deny-policy management are enabled together. Content grants,
requests, notifications, membership management, invitations, and delegated
sharing remain independently disabled. The committed
`scripts/client-portal-release-profile.json` explicitly selects
`default-on-eligibility`. It is a versioned release-intent declaration, not
production evidence. Repository-owned release checks must verify
the exact Ops Sync-to-Client service binding and named entrypoint before either
Worker is deployed. A missing or mismatched binding must fail closed without
acknowledging the Project Alpha event.

## Runtime gates

| Gate | Role |
| --- | --- |
| `PROJECT_ALPHA_PORTAL_SYNC_ENABLED` | Enables private portal projection dispatch inside Client. |
| `PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED` | Emergency legacy handler gate; production must be exactly `false`. |
| `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED` | Enables schema-v3 parsing/storage. |
| `CLIENT_PORTAL_HIERARCHY_V2_ENABLED` | Independent client authorization/read cutover. |
| `PROJECT_ALPHA_CATALOG_SYNC_ENABLED` | Enables private catalog dispatch. |
| `PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED` | Enables private service-assignment dispatch. |
| `CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED` | Independent downstream request-narrowing policy. |

Each inner projection keeps its existing strict parser and bound: catalog is
128 KiB; portal and service assignments are 256 KiB. Ops Sync allows 320 KiB
for the signed outer wrapper, then Client rechecks the exact inner limit.

## Preflight

1. Record the reviewed commits and currently deployed Worker versions.
2. Apply and verify all required additive D1 migrations. This routing change
   introduces no migration.
3. Run Client and Ops Sync typechecks, focused projection tests, configuration
   type generation, and production dry-run builds.
4. Verify Client configuration has the expected application key, the required
   private projection gates, and
   `PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED=false`.
5. Verify Ops Sync has the `CLIENT_PORTAL_PROJECTION_INGRESS` named service
   binding targeting `ltds-clients#OpsSyncPortalProjectionIngress`.
6. Verify the existing Ops Sync Access application, audience, and Project Alpha
   HMAC secret are unchanged. Client no longer requires a copied Project Alpha
   portal HMAC secret or portal-specific Access audience.
7. Probe both former direct portal-v2 POST paths on every admitted Client host;
   both must return 404 without reading a body or writing a receipt.
8. Confirm an existing public share and authenticated portal session still
   work. Never record cookies, tokens, link fragments, or secret values.

## Deployment order

1. Identify the reviewed commit and Worker artifact/version intended for
   deployment. Confirm the worktree is clean and the artifact is built from that
   exact commit. Record the currently active Worker version for rollback.
2. Run the Client typecheck and focused projection, origin-policy, and Worker
   tests against that exact artifact. Confirm the shared schema-v2 and schema-v3
   fixtures pass unchanged in both repositories. Also prove that Project Alpha's
   producer target is Ops Sync and that no direct `portal.*` target is present.
3. Run `npx.cmd wrangler d1 migrations list client-data --remote` from
   `apps/client`. It must report no pending migrations for the reviewed artifact,
   including `0121_client_workspace_hierarchy_v2.sql`,
   `0125_project_alpha_portal_projection.sql`, and
   `0129_portal_hierarchy_relations.sql`. If the deployed receiver contains the
   dormant v4 extension, also confirm
   `0190_portal_contact_assignments_v4.sql` is applied. Do not activate against a partially
   migrated database and do not roll migrations back.
4. Read back Worker custom domains/routes. Confirm Project Alpha's only ingress
   is the existing Ops Sync route and its Access application/audience are
   unchanged. Confirm the canonical
   `portal.ledgetopdroneservices.com` custom domain reaches `ltds-clients`, the
   legacy `client.ledgetopdroneservices.com` compatibility domain still reaches
   the same Worker, and no unrelated hostname routes to the internal namespace.
5. Read back the Operations-owned internal route/binding and confirm only Ops
   Sync can invoke it. Confirm external requests to
   `portal.ledgetopdroneservices.com/api/internal/project-alpha/*` are not a
   supported producer path. If an old path-specific Access application still
   exists, keep it deny-only during transition and remove it only in a separately
   reviewed cleanup after queued work is drained.
6. Check configuration by name and presence only. Confirm the Project Alpha
   connection still targets the exact Ops Sync webhook and uses the existing
   application key. Confirm Ops Sync has the reviewed Client Worker service
   binding and named entrypoint, and the two service-assignment flags remain
   false. The release preflight must reject a missing/misdirected binding, an
   enabled external portal ingress, or any disallowed adjacent
   client-authority/workflow flag. Deployed configuration still requires
   separate readback.
7. Confirm the receiver-only version has all projection configuration present
   with `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true`,
   `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true`, and
   `CLIENT_PORTAL_HIERARCHY_V2_ENABLED=false`. Confirm every adjacent flag
   enumerated by the preflight remains false.
8. Before activating this version, probe the currently deployed false state
   without sensitive logging:
   - missing or invalid Project Alpha Service Token at Ops Sync is denied and
     never creates an Operations or portal receipt;
   - a valid Project Alpha event with an invalid event HMAC is rejected without
     an internal delivery;
   - an authenticated Ops Sync event receives a retryable failure, not a false
     acknowledgement, when the internal Client receiver is disabled;
   - external `/api/internal/project-alpha/portal-v2` requests on every portal
     or legacy origin receive no projection-handler response; and
   - an existing legacy public share loads, and its same-origin session request
     remains admitted. Do not include share fragments or cookies in evidence.
9. Deploy `ltds-clients` first. Confirm the named entrypoint is exported and
   direct portal-v2 POSTs remain 404.
10. Deploy `ltds-ops-sync` second. Confirm the service binding resolves.
11. Send one signed portal projection through the existing Project Alpha event
    URL. Confirm both the source-qualified Ops receipt and the Client delivery
    receipt complete, then replay it and confirm duplicate acknowledgement with
    no second mutation. Exercise catalog and service-assignment envelopes only
    when their individual Client gates are intentionally enabled.

## Failure and rollback

- A missing Client binding, unavailable Client Worker, busy source fence, or
  transient D1 failure returns a retryable Ops Sync response and leaves the
  outer receipt pending.
- A malformed inner envelope, application mismatch, delivery-ID mismatch, or
  size violation is non-retryable and must not mutate Client state.
- If Client deployment fails, keep Ops Sync on its prior version.
- If Ops Sync deployment fails after Client succeeds, the unused named
  entrypoint is inert; roll Ops Sync back and investigate before retrying.
- Do not restore the direct portal HTTP routes as a rollback shortcut. Roll
  back both Workers to their last jointly reviewed versions if necessary.

1. Preserve the preflight version and evidence. Run the repository-owned release
   preflight against the reviewed ingest-only configuration. It must confirm the
   exact private service binding, both ingest flags are true, no direct portal
   producer route is enabled, and all adjacent authority and workflow flags
   remain false. Confirm the release diff contains no unrelated configuration
   change.
2. Activate the paired reviewed versions on `ltds-clients` and `ltds-ops-sync`
   and read back the private binding/entrypoint. Repeat the external internal-route
   rejection and legacy public-share/session checks before sending a valid
   projection.
3. Prove missing/wrong Project Alpha Access or event HMAC, stale timestamp,
   wrong application key, changed body digest, wrong delivery ID, wrong outer
   event type, and invalid nested schema are rejected with no portal receipt,
   checkpoint, or active-generation change. A source event is not acknowledged
   as complete until its required private invocation is durable.
4. Keep Project Alpha on its existing Ops Sync base URL and activate the reviewed
   portal event types/schema on that single connection. Send one bounded
   staging-equivalent event, verify Ops Sync's source receipt and internal
   delivery receipt, then reconcile one pilot workspace. Do not disclose
   Service Token or either HMAC in tickets, commands, logs, or screenshots.
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
8. This receiver-only window does not authorize client eligibility. For the
   current default-on requirement, follow R2 in the rollout manifest and the
   explicit release-profile transition below; the former hierarchy-only,
   individually enrolled pilot step is superseded. Contact metadata or an
   unverified email match alone must never create authority.

## Default-on eligibility release profile

Only after R0/R1 and joined eligibility/revocation verification, prepare a
separately reviewed commit selecting `default-on-eligibility` in
`scripts/client-portal-release-profile.json` (`schemaVersion: 1`). Set these five
flags exactly `true` in **both** Client and Operations configurations:

- `CLIENT_PORTAL_HIERARCHY_V2_ENABLED`
- `CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED`
- `CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED`
- `CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED`
- `CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED`

The receiver-only profile requires those flags exactly `false`; only Client's
existing omitted deny-management flag may remain absent. Missing or unknown
profiles, extra profile fields, partial bundles, and mixed local Worker states
fail closed. No environment variable or inferred flag combination selects a
profile. The original receiver-only validator remains strict independently.

Both profiles preserve receiver ingress, relation ingestion, Access/HMAC and
rotation checks and all unrelated Client false-flag constraints. Invitation
email remains false, as do Operations authenticated-delivery and project-access
expiry notifications. Default-on provisioning and historical backfill send no
invitation or announcement mail; eligibility grants no unshared delivery folder.
No Viewer setting changes belong in this transition.

The committed declaration and exact commit/artifact identify intended state,
not remote readiness. Separately verify migrations, recovery baseline, joined
tests, production authorization, and exact deployed versions/flags. Deploy and
read back Operations deny-management readiness before activating Client
eligibility. Run `npm run deploy` for the Client release; never bypass the
preflight with direct Wrangler. Record live first-login, backfill, revocation,
both-host session and preserved-public-link evidence separately.

No reconciliation-paused profile is implemented. The recorded receiver-only
version is an emergency access-disable rollback, not a promise of continued
hierarchy/deny-management reads. A normal pause retaining those reads requires
a separately reviewed exact configuration and gate change. In either case,
retain identities, workspace and denial records, preserve administrator opt-outs,
keep mail disabled, and preserve receiver compatibility for queued revocations;
never delete workspaces or denial state to simulate rollback.

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
   `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true`; keep the Ops Sync ingress
   trust and private Client Worker binding available. During a planned External
   Operations key rotation, keep the valid previous key available until queued
   events drain. This allows queued revocation/tombstone deliveries to
   authenticate and parse.
3. Coordinate a producer stop, then drain already queued ordered deliveries and
   required tombstones. Confirm their receipts are complete, checkpoints are
   contiguous, and no pending delivery still depends on a retiring External
   Operations key. Do not delete projection rows or D1 audit evidence.
4. Only after the producer is stopped and the drain is acknowledged, activate a
   reviewed receiver version with `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=false`.
   The relation flag may return to false only after no schema-v3 delivery can
   arrive. Retire previous External Operations key material only after the same
   proof. Access/DNS retirement is a separately approved final step, never the
   first rollback action.
5. Re-probe Ops Sync false-state behavior, external internal-route rejection, legacy public
   shares and same-origin sessions, Delivery health, and the final Worker/Access/
   flag state. Record the final state and the forward-fix owner.

If the receiver cannot remain contract-compatible for the drain, stop the
producer first, preserve all pending records and credentials, and escalate. Do
not force a flag-off state that strands revocations or retire the audience or
signing keys while Project Alpha can still retry.

Production evidence must include redacted version IDs, configuration readback,
the direct-route 404 probes, one successful event, one exact duplicate, and one
retryable Client-unavailable case.
