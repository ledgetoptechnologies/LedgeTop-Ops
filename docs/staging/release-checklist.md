# Staging release gate and command packet

This packet prepares commands; it does not authorize running them. Keep the
client portal, Dropbox, Google, permanent purge, and incoming uploads disabled.
The client-specific sequence is in
[client-portal-rollout.md](client-portal-rollout.md).

## Current credential boundary

Use `& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami` immediately before a release. Record only the
account, authentication method, permission names, and timestamp. Never copy an
OAuth token or API token into the evidence file.

Wrangler OAuth can manage Workers and D1 but does not prove Cloudflare Access
or Workers Builds visibility. Verify Branch control separately for Delivery,
Operations, and Ops Sync:

- production branch is exactly `main`;
- Builds for non-production branches is off;
- the dashboard or Builds API record is attached to the release ticket.

Do not push a branch merely to test this setting. Historical preview uploads
for Operations and Ops Sync contained production bindings even though they did
not become active deployments.

## Required non-secret values

- approved Project Alpha staging HTTPS origin;
- staging Access group ID and exact group name;
- Ops Sync staging service-auth policy and Project Alpha service-token owner;
- Delivery, Operations, Ops Sync, and self-hosted Viewer staging DNS readiness;
- `client-staging.ledgetopdroneservices.com` and
  `portal-staging.ledgetoptechnologies.com`, their one shared dedicated portal
  Access app/audience/group, and the separately reviewed public Bypass app/policy;
- reviewed commit SHA and current build-control evidence;
- D1 export paths and SHA-256 checksums.
- origin-restricted staging Mapbox public tokens for both Delivery and
  Operations;
- a non-production Operations triage recipient and exact allowed notification
  sender;
- each native test source's immutable source ID, connector revision, credential
  reference name, application key, allowed HTTPS origin, workspace/root/project
  public IDs, projected principal source version, and signed request/feedback
  feature version. Record credential fingerprints and secret names only, never
  `draftQuote.apiKey` or `draftQuote.hmacSecret` values;

`CLIENT_PORTAL_ENABLED` and every feature listed in
`REQUIRED_DISABLED_FEATURE_FLAGS` must be explicitly `false`;
`CLIENT_PORTAL_ORIGIN` and Operations `DELIVERY_BASE_URL` must be the client
staging origin. `PUBLIC_SHARE_ORIGIN` on both Workers and Client
`PUBLIC_BASE_URL` must be the anonymous delivery staging origin.
`CLIENT_PORTAL_ORIGINS` must contain exactly the two approved authenticated
staging origins.
`CLIENT_ACCESS_AUD`
must be the new portal app audience, never `POLICY_AUD`, `OPERATIONS_AUD`, or
`CF_ACCESS_AUD`.

The receiver-only projection path is infrastructure, not an activation flag:
Client must set `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true`, keep
`PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED=false`, and share the exact
`ltds_ops_staging` application key with Ops Sync. Ops Sync must bind
`CLIENT_PORTAL_PROJECTION_INGRESS` to the `ltds-delivery-staging`
`OpsSyncPortalProjectionIngress` named entrypoint. Do not provision a direct
Client portal Access audience, HMAC key ID, or portal HMAC secret.

Client migration `0189_primary_staff_folder_bindings.sql` must be applied and
verified before deploying the Operations build that exposes primary Client
Workspace folder linking. Keep authenticated-grant mutations disabled until
the active-primary-Operations-binding-without-active-receipt query in
`docs/operations/primary-client-workspace-folder-bindings.md` returns zero.
Record the migration hash, the zero-row readback, one coherent legacy backfill
or an explicit staff relink, stale-context suspension, and both grant-versus-
revoke transaction order tests in the release evidence.

The Client staging Worker and the single staging Client Portal Access
application must include both reviewed portal hosts:
`client-staging.ledgetopdroneservices.com` and
`portal-staging.ledgetoptechnologies.com`. Read back one unchanged audience and
policy set across both hosts. Record separate evidence for sign-in, hard
refresh, and same-origin Access logout on each host; authenticated host
switching; session-expiry denial on both hosts; immediate membership/grant
revocation on both hosts; unauthorized identity denial on both hosts;
cross-tenant denial on both hosts; same-origin mutation; and mixed-origin
denial. Canonical public links must remain on the reviewed public host,
reachable without Access, and absent from the secondary portal namespace. A
result from one host cannot be copied or inferred for the other host. Reference
both the exact post-change application/audience/
destination/policy readback and the pre-change Access/custom-domain rollback
snapshot in the evidence packet; a bare boolean is not sufficient readback.

The attachment upload CORS artifact is
`docs/staging/request-attachments-r2-cors.json`. Preflight requires that exact
policy: only the two reviewed client staging origins, only `PUT`, only the `content-type`
request header, only `etag` exposed, and a 300-second preflight cache. After
separate R2 mutation approval, apply it only to `client-data-staging` with
`wrangler r2 bucket cors set client-data-staging --file docs/staging/request-attachments-r2-cors.json`
and verify it with `wrangler r2 bucket cors list client-data-staging`. The
browser evidence must include the exact allowed origin and an out-of-scope
origin denial. Do not apply the production artifact to staging.

The invitation-mail gate also requires an onboarded staging Email Service
domain, `CLIENT_PORTAL_INVITATION_EMAIL` restricted with
`allowed_sender_addresses`, and an exact matching
`CLIENT_PORTAL_INVITATION_FROM`. Keep the email feature flag false during
preflight; enable it only for the controlled acceptance test after the evidence
packet and Access enrollment gate are approved. No local or staging command may
use a remote email binding unintentionally.

`CLIENT_PORTAL_ACCESS_ENROLLMENT_READY` is a separate operator attestation and
must remain false until a dedicated, internal workspace reconciler has proven
dedicated client-group isolation, multi-workspace retention,
last-eligibility revocation, and zero staff-group mutation. The global flag is
not sufficient to release mail: before each outbox lease, migration `0133`
requires a live server-recorded receipt bound to that invitation, workspace,
normalized-email hash, current invitation-token hash, and monotonic enrollment
version. Migration `0135` persists the highest revoked version before or after
the positive receipt arrives; prove both orderings, concurrent delivery, and a
legitimate later-version re-enrollment. Revocation and lease/send race evidence
is mandatory. The
legacy `client_access_sync_outbox` is account-scoped and imperative, and its
processor is not deployed; it cannot safely represent workspace-v2 desired
membership. Manual pre-enrollment may test acceptance mechanics but does not
satisfy the autonomous-invitation release gate.

Copy `docs/staging/release-evidence.json.example` to the ignored path
`.backups/staging-release-evidence.json`. Record only booleans, identifiers,
timestamps, secret names, hashes, and evidence references. Record SHA-256 for
all three ignored staging configs immediately before each mutation phase;
`staging:evidence:check` rejects any later config drift.

After deployment and before enabling any capability window, run the guarded
GET-only collector from `docs/staging/README.md` with the dedicated staging
Access identity. Attach its sanitized report to the release ticket; it does not
replace the independently reviewed evidence packet or any manual/browser gate.

Before collecting deployment evidence, replace every `FINAL_*` value in
`scripts/staging-requirements.mjs` with the settled Ops, Viewer, and Project
Alpha commits, the immutable Viewer tag-plus-digest, and all Project Alpha
migration hashes. Set `RELEASE_CONTRACT_FINALIZED=true` only after independent
comparison with those repositories. The verifier intentionally fails while any
release-candidate placeholder remains.

The current candidate inventory extends through Client `0195`, Operations
`0052`, and Project Alpha `0083`. The reviewed Operations runtime boundary is
`ab4d83fac9f0775228398cc38f5e28c573e25399`; later commits through the prepared
branch HEAD are CI/test portability and release-packet maintenance, so using
HEAD as the runtime identity would create a circular self-pin. Project Alpha is
pinned independently at `67cfe73a9a2c4507524a017cd8996aab5598c534`.
Keep `RELEASE_CONTRACT_FINALIZED=false` until independent cross-repository,
image, migration, and live staging evidence is complete. Any runtime change
after `ab4d83f` requires a newly reviewed non-circular boundary and coordinated
evidence refresh.

The Viewer evidence is separate from the three Wrangler deployments. Record its
exact image/commit, a SHA-256 of the non-secret `viewer.env` shape, secret names
only, mode `0600`, health/readiness, the exact matching
`X-LTDS-Viewer-Revision` and `X-LTDS-Viewer-Schema-Version` headers from both
public probes, exact `EXPECTED_HOST`, forwarded Host,
narrow LAN bind/firewall boundary, direct-IP/wrong-Host denial, successful
canonical Viewer Host forwarding through the proxy, rootless/capability
state, persistent volume, read-only imports, range/no-store behavior, and a
tested immutable-image rollback. Keep `PROCESSING_PLATFORM_ENABLED`, the
processing Compose profile, WebODM discovery, `PROXY_SHARED_SECRET`, and
`TRUSTED_PROXY_ADDRESSES` off in the baseline. The optional proxy secret is not
part of the required manifest for this release.

Project Alpha evidence must identify its exact commit and immutable web/cron
image digests, migration `0066`/`0067`/`0068`/`0069` ledger and source hashes, all eleven
installation settings and profile capabilities/delivery still off, the inert
one-minute outbound sender, non-secret delivery key IDs, encrypted-secret and
redacted-evidence proof, retry/dead-letter/revocation behavior, fresh backup,
and a non-destructive restore/fix-forward drill.

Project Alpha is the rollback-order exception: disable projection authority
first so scoped revocation tombstones are queued, but keep the affected
profile's delivery switch, the sender, and `portal_outbound_delivery_enabled`
on until every tombstone is acknowledged. Only then turn outbound delivery
off. The rollback evidence must prove this drain order; disabling the sender
first can strand stale downstream authority.

## Required staging secret names

The canonical non-secret list is
`docs/staging/staging-secret-manifest.json`. Wrangler configs must not contain a
top-level `secrets` pseudo-field; use the sidecar to review ignored secret-file
keys and remote secret-name listings.

Delivery:

- `DELIVERY_SESSION_SECRET`
- `DELIVERY_ACCESS_CODE_PEPPER`
- `AUDIT_IP_SECRET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `PROJECT_ALPHA_CATALOG_HMAC_SECRET`
- `PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_SECRET` (rotation-overlap staging proof)
- `PROJECT_ALPHA_PRICING_HINT_API_KEY`
- `PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET`
- `CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET`
- `CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID`
- `CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY`
- `CLIENT_DELEGATED_SHARE_SESSION_SECRET`
- `CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET`
- `PROJECT_ALPHA_CONNECTOR_CREDENTIALS` (the same reviewed source-key envelope
  provisioned independently to Delivery, Operations, and Ops Sync)

Operations:

- `OPERATIONS_SESSION_SECRET`
- `DELIVERY_TOKEN_SECRET`
- `DELIVERY_ACCESS_CODE_PEPPER`
- `AUDIT_IP_SECRET`
- `PROJECT_ALPHA_API_KEY`
- `PROJECT_ALPHA_DRAFT_QUOTE_API_KEY`
- `PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_DELIVERY_UPLOAD_ACCESS_KEY_ID`
- `R2_DELIVERY_UPLOAD_SECRET_ACCESS_KEY`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET`
- `INCOMING_SESSION_SECRET`
- `INCOMING_ACCESS_CODE_PEPPER`
- `INCOMING_PICKUP_SECRET`
- `THUMBNAIL_INGEST_SECRET`
- `VIEWER_SERVICE_HMAC_SECRET`
- `VIEWER_EVENT_HMAC_SECRET`
- `PROJECT_ALPHA_CONNECTOR_CREDENTIALS`

Ops Sync:

- `CF_ACCESS_GROUP_API_TOKEN`
- `PROJECT_ALPHA_WEBHOOK_HMAC_SECRET`
- `PROJECT_ALPHA_CONNECTOR_CREDENTIALS`

Self-hosted Viewer (record names in `viewer.configuration.secretNames`, not in
the Wrangler manifest):

- `SESSION_SECRET`
- `SERVICE_AUTH_SECRET`
- `VIEWER_EVENT_SECRET`
- `PROVIDER_CREDENTIALS_KEY`

The staging manifest currently requires the complete Operations secret set
even while incoming capability flags remain disabled. This keeps the checked
configuration, evidence packet, and version upload contract identical and
fail-closed. Never place secret values in Git, Wrangler `vars`, shell
arguments, or release evidence.

## Non-mutating gates

Run from repository root:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami
npm.cmd run staging:check
npm.cmd run staging:check:test
Get-FileHash -Algorithm SHA256 apps/client/wrangler.staging.json
Get-FileHash -Algorithm SHA256 apps/operations/wrangler.staging.json
Get-FileHash -Algorithm SHA256 apps/ops-sync/wrangler.staging.json
npm.cmd run staging:release:prepare

& '.\apps\client\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/client/wrangler.staging.json --outdir C:\tmp\ltds-delivery-staging-dry-run
& '.\apps\operations\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/operations/wrangler.staging.json --outdir C:\tmp\ltds-ops-staging-dry-run
& '.\apps\ops-sync\node_modules\.bin\wrangler.cmd' deploy --dry-run --config apps/ops-sync/wrangler.staging.json --outdir C:\tmp\ltds-ops-sync-staging-dry-run
```

The isolated incoming staging hostname is required for quarantine intake
testing. Keep direct browser uploads into client delivery storage disabled with
`DIRECT_DELIVERY_UPLOADS_ENABLED=false` during baseline deployment. Enable it
only for the separately approved synthetic Operations acceptance run described
in the [thumbnail and upload runbook](../media-thumbnail-pipeline.md), then
return it to the intended reviewed state and record the deployed value. Client
Portal, public-share, and Incoming identities remain denied in either state.

The example evidence intentionally fails until the client Access/public-path
contract, migrations, end-to-end tests, final default-off state, and every
Ops-Sync-to-Client private projection dependency in `REQUIRED_EXTERNAL_GATES` are recorded. Do not
mark future or inferred results true.

It also requires the pushed source ref, exact deployed version/config hashes,
second-empty migration lists, foreign-key and reapply checks, live resource and
entitlement inventory, rollback targets/drill, referenced production-unchanged
proof, and the complete disabled-flag set for each deployed Worker. A generic
`ready` statement cannot satisfy an external gate; every named proof in
`REQUIRED_EXTERNAL_GATE_PROOFS` must be current and referenced.

For this checklist, `idempotentReapplyPassed` is specifically a second
`wrangler d1 migrations apply` against the same `d1_migrations` ledger that
returns `No migrations to apply`. Do not execute migration SQL files directly
for this proof: ledger-once historical migrations intentionally contain SQLite
DDL without a safe raw-SQL replay form.

`activationPlan.requestedFlags` is empty for this release preparation. Any
later staging activation is validated against
`FEATURE_FLAG_ACTIVATION_POLICIES`; flags marked prohibited require their own
release packet, and dependent gates must remain current. For the controlled run
that creates a not-yet-available proof, set `phase=evidence-collection`, name
the one `collectingGate`, request exactly one staging flag, retain current
`stagingGates` prerequisite proofs, record the rollback reference, and explicitly
attest `productionFlagsRemainOff=true`. Restore the staging flag to false before
marking the collected gate ready. A later `post-evidence-validation` activation
requires every final gate. Production activation is never authorized by this
packet.

## Read-only backup and migration preflight

After identity, exact config/resource inventory, and branch-control checks pass,
create fresh exports before requesting mutation approval. Bind each export to
its exact staging D1 name/ID, timestamp, byte count, and SHA-256 in evidence.
A very small export is not useful recovery evidence unless the database is
reviewed and explicitly confirmed intentionally empty:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 export client-data-staging --remote --config apps/client/wrangler.staging.json --output .backups/client-data-staging-pre-release.sql --skip-confirmation
& '.\apps\operations\node_modules\.bin\wrangler.cmd' d1 export ltds-ops-staging --remote --config apps/operations/wrangler.staging.json --output .backups/ltds-ops-staging-pre-release.sql --skip-confirmation
Get-Item .backups/client-data-staging-pre-release.sql
Get-Item .backups/ltds-ops-staging-pre-release.sql
Get-FileHash -Algorithm SHA256 .backups/client-data-staging-pre-release.sql
Get-FileHash -Algorithm SHA256 .backups/ltds-ops-staging-pre-release.sql
```

Update the evidence file as operator-owned results become available, but do not
claim post-deployment fields before a version exists. Only after local
preparation and separate migration approval pass, rerun identity and config
checks immediately before applying migrations:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami
npm.cmd run staging:check
```

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations list client-data-staging --remote --config apps/client/wrangler.staging.json
& '.\apps\operations\node_modules\.bin\wrangler.cmd' d1 migrations list ltds-ops-staging --remote --config apps/operations/wrangler.staging.json
```

These are list-only commands. Do **not** run a generic all-pending Delivery
apply from the combined candidate when `0172` or any of `0179`-`0186` is
pending. Both ranges contain deployment barriers described below. A passing
preflight proves configuration shape; it does not make a combined migration
apply safe.

If the Delivery list includes
`0172_project_access_authority_history.sql`, stop before the generic Delivery
`migrations apply` action. Migration 0172 starts append-only coverage at
apply time and is the explicit exception to this packet's normal
migration-first order. Confirm every predecessor is already applied; otherwise
resolve those predecessors in a separately reviewed release.

Writer-first alone is not a sufficient barrier. Freeze request/invitation
create, approve/publish, accept and revoke; authenticated-grant create/publish,
revoke and restore; and every expiry reconciliation or notification path that
invokes reconciliation. Drain in-flight HTTP requests, leases, queue items,
scheduled jobs and reconciliation batches so no operation that observed
history as absent can commit after activation. Both new versions must have
`PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false`; this default-false flag is
the post-cutover barrier and cannot replace the external freeze needed for old
versions. Close external mutation ingress/schedulers, upload both compatible
writers, shift **100% of traffic** to the flag-false versions, then drain every
old-version and in-flight request/job. Reads remain live throughout.
Before 0172, verify new explicit-term writes fail `503`, existing
reads/enforcement remain available, and the Client Hub reports project-access
history as `not_collected`. Only after both writers and the drain are proven may
the operator take the final shared-Delivery backup and apply 0172. An old or
already-running pre-history writer must never commit after
`collection_started_at` exists.

Migration `0179_service_assignment_policy_proof_v2.sql` is a second mandatory
split-release barrier. Generate the ignored expand config from the already
validated Client staging config with
`npm run staging:client:expand-0179:generate`, then verify it with
`npm run staging:client:expand-0179:check`. The generator preserves the whole
staging config and exact D1 ID/bindings, and adds the literal Wrangler pattern
`migrations/0179_service_assignment_policy_proof_v2.sql`; it refuses a stale
or broadened output and never copies SQL. Record that derived config as the
immutable expand input, then retain the ordinary staging config as the final
input containing `0180`-`0186`. Never copy files out of the combined tree ad
hoc, edit the migration ledger, or execute these files as raw SQL.

1. Keep `PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED` and
   `CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED` false.
2. With explicit `--config apps/client/wrangler.staging.expand-0179.json`, list
   pending migrations and stop unless the only listed migration is `0179`.
   Apply it with the same config; verify the ledger, foreign keys, and additive
   v2 proof columns. A later list with this config must report no migrations.
3. Upload the compatible Client writer, record its immutable version ID, shift
   100% of Client traffic to it, and drain every old Client request/job that can
   write service-request drafts or submissions. Confirm new writes populate
   only the strict v2 proof and include `reviewId`/`reviewRevision`.
4. Only after the drain is evidenced may the final input apply
   `0180_service_assignment_policy_v1_contract.sql`,
   `0181_service_assignment_request_policy_reviews.sql`, and notification
   migrations `0182`/`0183` in order. With native capabilities still unavailable,
   apply `0184_native_client_feedback.sql`,
   `0185_native_service_request_ownership.sql`, and
   `0186_delivery_notification_authority_provenance.sql`, followed by
   `0187_authenticated_content_audit.sql`,
   `0188_native_feedback_completion_notices.sql`, and
   `0189_primary_staff_folder_bindings.sql`, followed by Client `0190` through
   `0195`, in order. Verify the 0187 collection
   state is still unset and its retention-delete gate is closed. Before the
   Operations upload, prove the 0189 unreceipted-active-binding query returns
   zero. Then apply Operations through
   `0052_project_operational_reassignment_recovery.sql` and deploy the paired final
   applications with every user-facing portal capability still default-off,
   receiver sync true, direct portal HTTP false, and the private Ops Sync to
   Client binding verified.
5. Record `serviceAssignmentV2ExpandApplied`, the compatible writer version,
   `serviceAssignmentOldWritersDrained`,
   `serviceAssignmentContractMigrationsApplied`, and the barrier evidence
   reference in the release evidence. The second Wrangler list/reapply must
   return `No migrations to apply` only after the final phase.

If no independently reviewed expand-only migration input exists, stop. The
presence of all eight files in one checkout is not permission to apply them in
one command.

Apply Delivery first because Operations binds the Delivery database. Record
every migration result. For this milestone, explicitly confirm Delivery
`0096_client_portal_foundation.sql` through
`0112_public_share_location_privacy.sql`, then `0114_delivery_share_prefix_lookup.sql`
through `0171_secondary_workspace_membership_management.sql` (`0113` is
intentionally reserved), apply `0172_project_access_authority_history.sql`
only at its writer-first barrier, then `0173`-`0179` with `0179` as the final
expand step. Apply `0180`-`0183` only after the compatible-writer drain above,
then apply `0184`-`0195` migration-first before the paired final applications.
Confirm Operations
`0014_staff_acl_controls.sql` through
`0052_project_operational_reassignment_recovery.sql`. Migration `0100` removes
`share_version` from the delivery-grant parent key so existing share
rotation/revocation updates cannot be blocked by a portal grant; the grant
still records the approved version for authorization checks. Reject any
unexpected pending migration. Migration `0105` must be present before the
Operations version that exposes direct authenticated folder grants or runs its
five-minute notification consumer; `0106`/`0107`/`0108` must be present before
thumbnail jobs or cleanup; `0109` must be present before photo location
extraction or map routes run; `0110` must be present before a `Jobs/` backfill
run; `0111` must precede prebuilt registration, Container fallback activation,
or exact-ETag derivative reconciliation. Migrations `0112` and `0114`-`0150`
must precede public location privacy, indexed share lookup, client notification,
request-v2, attachment, workspace hierarchy, membership, delegated-share,
catalog/hierarchy projection, and directory-recipient activation.
`0132` must be applied before invitation acceptance is enabled: verify a fresh
apply and idempotent reapply, `PRAGMA foreign_key_check`, exact-project guest
file/request access, sibling-project denial, immediate suspension, and two
independent workspace bridges for one verified issuer/subject. Staff manager
recovery must also prove transfer-before-offboarding and reject local removal
of a Project Alpha-managed manager.

`0017` must
precede the Operations thumbnail renderer APIs and be present before job-brief
routes; `0018`/`0019` must precede
browser-upload and conflict-resolution routes; `0020` must precede the internal
SOP library; `0021` must precede Project Alpha sync hardening; `0022` must
precede bounded R2 retry state; and `0023` must precede project/task SOP
revision pinning. Migration `0131` seeds a cutoff-pinned,
video-only recovery pass; confirm it reaches `completed` and that repaired rows
remain pending until the authenticated TrueNAS worker claims them. It must not
publish those rows to the Cloudflare thumbnail queue. Worker
rollback does not undo either database.

The native request and feedback release contract is
[native portal requests and feedback](../operations/native-portal-requests-feedback.md).
At final upload, `CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED` must remain false and
every exact Project Alpha source must continue to advertise native request and
feedback features as unavailable. Do not enable either source feature merely
because primary request-v2 or primary feedback is available. Before any later
activation, prove exact source/workspace/identity/project or target authority,
colliding-ID isolation, current principal source revision, revocation races,
storage-only account exclusion, and exact outbound destination.

For rollback, first disable `CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED`, withdraw the
two native source features, confirm signed capability readback, and drain request
mutations, attachment finalization, quote commands, feedback transitions, and
completion-notification leases. Retain migrations `0184`-`0195` and Operations
`0050`-`0052`.
After the first native storage binding or registered draft-quote fingerprint is
created, do not roll back to code that lacks storage-account exclusion or
connector-fingerprint enforcement; use the last compatible version or fix
forward.

Before version upload, verify rather than infer the remaining operator-owned
media prerequisites: the staging thumbnail queue and DLQ exist, Operations has
the exact `THUMBNAIL_QUEUE` producer, main consumer and DLQ consumer; the
private `THUMBNAIL_RENDERER` Container binding resolves with four maximum
instances, internet disabled and no SSH/public route; and all five Operations
crons are present: consolidated 15-minute work, five-minute request processing,
Client Hub indexing, hourly source recovery, and the offset native-delivery
notification scheduler. Confirm the
existing R2 object-create notification still feeds only the staging file-event
queue; do not add an overlapping notification rule. Confirm the path-specific
Cloudflare Access Service Auth policy and `THUMBNAIL_INGEST_SECRET` before a
TrueNAS registration smoke. The repository examples and passing preflight prove
configuration shape only, not remote resource or Container entitlement.

Staging navigation evidence must show that Delivery initially requests
`Jobs/Clients/`, an authorized global operator can use the `Jobs` breadcrumb to
request the true `Jobs/` root, and a scoped operator cannot activate that root.
Upload synthetic supported media in both `Jobs/Clients/` and another authorized
`Jobs/` folder and verify the same queue lifecycle. Inject one transient
processing failure and prove exactly one bounded second lifecycle; permanent
oversize and invalid/encrypted cases must remain icon-only. Supported PDFs must
render page one. Office, audio, and archive files remain icon-only. The
digest-pinned TrueNAS `queue-renderer` must use `includeKind=all` to lease,
render, upload, and complete one synthetic JPEG, PNG, PDF, and video. Prove a
live TrueNAS image/PDF/video lease causes zero Cloudflare thumbnail-body or
Container source reads; bounded best-effort image-location/EXIF reads remain an
independent metadata path. Prove signed heartbeats keep the TrueNAS backlog
primary while every slot is busy, then stop TrueNAS and prove stale-presence
reconciliation lets Cloudflare handle only an unleased image/PDF. Prove that
heartbeat/fail/complete echo the claim's
`leaseId`, and that an older attempt cannot mutate a reclaimed row. Prove the
15-minute raw server/rclone prebuilt
grace, the 30-second direct-upload grace, and private Container fallback
independently. Do not enable a delete-authoritative TrueNAS
source sync until browser/team prefixes are disjoint and excluded by path; R2
metadata tags are not a deletion boundary.

Record that end-to-end proof under the mandatory
`trueNasThumbnailQueueRenderer` external gate. The evidence must identify the
deployed `queue-worker` image digest, startup capability record, configured
`LTDSTHUMB_WORKER_CONCURRENCY`, RAM-backed `/scratch` and `/cache`, and show that
it treats `leaseId` as opaque. Repository tests cannot substitute for this live
TrueNAS-to-Cloudflare check.

After applying 0172, record both authority-history tables, exactly one immutable
state row, canonical UTC `collection_started_at`, and an empty
`PRAGMA foreign_key_check`. Prove exact invitation and authenticated-grant
lifecycle events, exact replay and conflicting replay rejection, bounded expiry
reconciliation, sibling workspace/source/project exclusion, and the Client Hub
**available since** label. Record at least one canonical test lifecycle event
after the collection start. After schema verification, enable
`PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED` in both Workers together while
general mutation ingress remains frozen; run the isolated test, then reopen
ingress/schedulers only after the event and coverage evidence pass. A partial schema is a
hard failure. Retain the new writers, immutable start row and
`PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false` during rollback; fix forward
instead of restoring an older writer or guessing a backfill.

After applying 0187, verify all three authenticated-content tables, both
timeline indexes, and all four immutability/delete-guard triggers exist. The
singleton history row must have `collection_started_at=NULL`, and the retention
control row must have `delete_enabled=0,delete_before=NULL`. Upload and deploy
the compatible Client and Operations versions with
`CLIENT_PORTAL_CONTENT_AUDIT_ENABLED=false`; the Client version must already
carry the independently provisioned `CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET`.
Only a separately approved activation version may turn the flag on and establish
the immutable collection boundary. After that boundary exists, rollback keeps
0187 and compatible code in place: returning the flag to false deliberately
fails body-bearing authenticated preview/download requests rather than creating
an unaudited gap.

## Separately approved version and deployment sequence

Do not use `wrangler secret put`: it deploys a new version immediately.
Prepare ignored per-app secret files and use `versions upload --secrets-file`
to create reviewable staging versions without routing traffic. Immediately
before this mutation phase, rerun identity and local preparation checks. Full
evidence verification is post-deployment so it can bind real version IDs:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' whoami
npm.cmd run staging:release:prepare
```

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' versions upload --strict --config apps/client/wrangler.staging.json --secrets-file '.backups\delivery-staging.secrets.json'
& '.\apps\operations\node_modules\.bin\wrangler.cmd' versions upload --strict --config apps/operations/wrangler.staging.json --secrets-file '.backups\operations-staging.secrets.json'
& '.\apps\ops-sync\node_modules\.bin\wrangler.cmd' versions upload --strict --config apps/ops-sync/wrangler.staging.json --secrets-file '.backups\ops-sync-staging.secrets.json'
```

Before upload, compare only the secret key names in each ignored file to the exact manifest. For an existing staging Worker, also record `wrangler secret list --config <explicit staging config>` and reject or explicitly approve every unexpected name. Record version IDs and inspect bindings before any deployment. Deploy only the
reviewed staging version through an explicitly approved version deployment.
Do not run package `deploy` scripts, which target the default production
configuration.

After deployment, verify Access rejection, host rejection, health, role and
object authorization, fault handling, recycle/restore, audit logs, queue/DLQ,
and rollback. Ops Sync stays undeployed and default-deny until Project Alpha
service auth, Access group authority, and the exact timestamp/body HMAC contract
are verified. If Ed25519 is added later, prove its precedence and rotation path
separately before configuring a public key.

For the portal, first prove the false flag returns `404`. Temporary activation
requires its own approval and version; after the full client/team/request/share
matrix passes, deploy a reviewed false version again. Evidence passes only
after the false state is restored. The Project Alpha payment/billing contract
must be ready, but it never substitutes for LTDS authorization checks.

After all controlled tests, deploy the reviewed all-false version again, record
its immutable version IDs and binding/config hashes, complete every structured
evidence field, and run:

```powershell
npm.cmd run staging:release:verify
```

That command reruns local preparation and validates the complete current
post-deployment packet. It performs no remote action.
