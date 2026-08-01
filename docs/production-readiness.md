# LTDS delivery production-readiness runbook

This runbook covers source-controlled readiness work only. Enabling provider
flags, creating OAuth applications, provisioning secrets, applying remote
migrations, changing R2 notification rules, enabling billed products, and
deploying Workers remain explicit operator actions.

## Release gates

Keep the R2-backed Delivery portal as the default client path. Cloud export and
staff import are optional capabilities and must fail closed. A disabled
capability must not render an operational button, and its API must return a
stable, safe error code without exposing credentials or provider response
bodies.

Cloudflare Access is the perimeter identity check, not the LTDS authorization
system. Every server route must additionally derive the LTDS principal and
resource context server-side and enforce the applicable role, division, client,
share/job, object key/prefix, and operation permission. A valid Access JWT,
client-supplied division, or knowledge of an R2 key is never sufficient
authority. Cross-division and cross-client object tests are release-blocking for
read, range, preview, import, export, upload, delete, restore, and purge routes.
The Operations ACL and scoped-query tests are evidence for part of this model;
they are not evidence that every route has been audited.

### Accepted deployment record (2026-07-30)

The topic branch `agent/production-readiness` is at commit `fea54be` and draft
PR 1. Pushing that branch caused the configured Cloudflare Git integration to
publish Delivery version `93d188ff-9586-4755-9a3d-63b0f8f5d8fa` to production,
replacing `7c218dd4-3fee-4b85-b9b7-1c9f54365807`. The operator has explicitly
accepted leaving that Delivery version live and does not want a rollback.
Recorded post-deployment evidence was a healthy Delivery health response, with
Dropbox, Google, and permanent R2 purge flags disabled. Operations and Ops Sync
were not redeployed, and no remote migrations or secrets were changed.

The local verification associated with the change set passed TypeScript checks,
Delivery's 105 tests, Operations' 118 tests, Ops Sync's 18 tests, all production
builds, and `git diff --check`. These results establish source/build quality at
that commit; they do not substitute for inspecting the deployed version's
bindings, flags, migrations, routes, or logs.

The unexpected topic-branch deployment is itself a failed release-control gate.
No further production mutation is allowed until an operator records the current
Git integration settings and configures one of these deliberate models:

- production deploys accept only `main` after review and environment approval;
- non-production branch builds deploy only to isolated preview Worker names and
  hostnames that have no production routes or custom domains; or
- automatic deployments are disabled and a reviewed, manually dispatched
  release workflow deploys a pinned commit.

Do not test this control by pushing another branch. Inspect the integration's
production branch, branch include/exclude rules, Worker target/name, route and
custom-domain attachment, build and deploy commands, token scope, and variable
mappings. Preserve the settings as release evidence. A preview is not isolated
if it shares a production Worker name, D1 database, R2 bucket, queue, Workflow,
OAuth callback, Access audience/policy, route, or custom domain.

Before a staging rollout:

1. Export the Operations and Delivery D1 databases and record the deployed
   Worker version IDs.
2. Create separately named staging Workers, D1 databases, R2 buckets, queues,
   dead-letter queues, Workflows, Access applications/audiences, hostnames, and
   OAuth applications/callbacks. Never bind staging Workers to production
   data-plane resources.
3. Validate generated Worker binding types and compare every required binding
   with the staging version configuration.
4. Register the exact staging OAuth redirect URI. Wildcards and alternate hosts
   are not acceptable.
5. Provision secrets interactively. Do not place them in build variables,
   Wrangler configuration, CI logs, or tickets.
6. Deploy with provider flags disabled, verify baseline Delivery behavior, then
   enable one provider in staging.
7. Preserve the prior Worker version and D1 exports until acceptance completes.

For the client portal milestone, also reserve a distinct client staging host
on the existing staging Delivery Worker. Create a dedicated path-scoped client
Access app/audience/group and a separate public-share Bypass app/policy; do not
reuse Delivery, Operations, Ops Sync, staff, or production client authority.
Keep `CLIENT_PORTAL_ENABLED=false`, bind `CLIENT_PORTAL_ORIGIN` and
`PUBLIC_BASE_URL` to the client staging origin, and prove the exact public path
and password/session contract before any temporary activation.

Repository configuration must use explicit Wrangler staging environments or
checked-in staging templates whose resource IDs are placeholders. Resource IDs,
account IDs, routes, secrets, and OAuth credentials must be operator-supplied
and must not be copied from production. A preflight must fail if staging is
missing a binding, resolves to a production resource/name/hostname, enables a
provider or `R2_PURGE_ENABLED`, or has a dirty/unpinned build input. Deployment
and migration remain separate commands; migration requires a named database and
an explicit backup checkpoint.

A deliberate staging-to-production release is: merge only after review and
local CI; deploy the pinned commit to isolated staging; apply staging migrations;
run acceptance and fault-injection tests; record versions, bindings, flags, and
evidence; obtain production approval; back up production D1; apply reviewed
production migrations; deploy the same pinned commit with optional capabilities
still disabled; run baseline smoke tests; and only then request separate
approval for each capability rollout. A branch push alone is never a release.

The portal schema gate requires Delivery migrations `0096`–`0100` and
Operations `0014`–`0016`, with fresh staging exports and exact list/apply
evidence. Client `0100` preserves independent share rotation/revocation by
removing `share_version` from the delivery-grant foreign-key parent while
retaining the recorded version as a fail-closed authorization check. These
migrations are not rolled back with Worker code. The Project
Alpha payment/billing contract is a blocking dependency, never an exception to
local staff, client-team, account, project, delivery, request, or billing ACLs.
After separately approved staging activation tests, restore the false flag and
record that state before production review. Follow
[the client portal staging packet](staging/client-portal-rollout.md).

Rollback means disabling the affected capability, rolling the Worker back to
the recorded version, allowing in-flight Workflows to reach a safe terminal
state or cancelling them, and restoring D1 only when a schema/data rollback is
actually required. Disabling a feature must not delete authorization, job,
trash, or audit records.

## Dropbox import acceptance

- The manifest/session capability reports disabled when any flag, client ID,
  secret, Workflow binding, or required schema is unavailable.
- Staff without administrator status but with the scoped
  `delivery.files.upload` permission can import only into prefixes they may
  upload to. Staff without that permission cannot start, browse, or queue an
  import.
- OAuth uses PKCE, one-time state, the exact callback URI, short state expiry,
  encrypted credentials, refresh-token rotation, and purpose-bound
  ciphertext. Denial, stale state, replay, mismatched state, and expired
  credentials produce safe errors.
- Browse refreshes an expiring access token. Provider error bodies and tokens
  never reach the browser or logs.
- Test empty folders, one small file, a file above 100 MiB, a multi-gigabyte
  file, 429/5xx retry, short reads, source mutation, cancellation between
  chunks, Workflow restart, multipart abort, and cleanup.
- No file path buffers a complete user-controlled object in Worker memory.
- Verify imported object byte count, destination ownership, conflict policy,
  queue indexing, audit event, and final job counters.

## Client cloud-copy acceptance

- A client can still download originals and prepared ZIPs when every cloud
  provider is disabled.
- Provider buttons come only from server capabilities. OAuth is authorized by
  the client into an account they control; LTDS never asks for a provider
  password.
- Verify revoked, expired, moved, or version-changed Delivery shares before the
  snapshot and between every copied item.
- Pin every R2 read to the snapshotted ETag and size. A changed object fails
  safely instead of copying mixed versions.
- Dropbox tests cover exact folder hierarchy, autorename, true skip semantics,
  duplicate names, interrupted upload-session resume, cancellation, refresh,
  retry exhaustion, provider quota responses, and authorization cleanup.
- Exercise files smaller than one chunk, exactly one chunk, multiple chunks,
  and the documented maximum. Verify provider-side byte count and checksum
  where the provider exposes one.
- Job creation and byte/file totals are quota bounded. Logs identify provider,
  job, item, safe error code, attempt, and outcome without tokens, session
  URLs, grants, or client filenames when avoidable.
- Google Drive remains unavailable until the browser completes the OAuth
  callback, launches a restricted Picker, posts the selected folder ID to the
  one-time activation endpoint, and then follows the resulting job. Backend
  scaffolding alone is not a production capability.

## Identity-bound recycle bin

Deletion is a two-stage state transition:

1. An ownership-authorized operation creates a tombstone that hides the exact
   key or prefix immediately and records a manifest of every source and derived
   object as key, R2 ETag, size, relation, actor, and retention deadline.
2. Restore only changes tombstone state during the recovery window. No object
   copy is necessary because soft-deleted objects remain in place.
3. Purge claims the tombstone idempotently, re-lists its scope, and compares all
   current identities with the deletion manifest before deleting anything.
   Missing objects are already safe; changed or unmanifested objects block the
   entire purge and raise an operator-visible audit event.
4. Only a fully matched manifest is deleted. Preview manifests, thumbnails,
   posters, temporary derivatives, and other registered artifacts are tied to
   their source/job relationship. Hidden naming alone is never proof of
   ownership.

Restore and retention are safety controls, not just UI states. Each tombstone
must have an immutable created-at time, actor, ownership scope, retention
deadline, and manifest identity. Restore must be ownership-authorized,
idempotent, rejected after purge starts or retention expires, and auditable.
Retention expiry makes an object eligible for an explicitly enabled purge; it
must not itself delete data. Legal or operational holds override expiry. Backup
and restore drills must prove D1 tombstones/manifests and R2 objects can be
recovered together without reviving access that has since been revoked.

This includes an outstanding code gate: restore currently blocks after
`purging_at` is set, but does not enforce `purge_after`/retention expiry
server-side. Expired restore requests must fail safely and have focused tests.

This protects objects uploaded directly with R2/S3 tools: a visible object is
manifested when the authorized delete begins, regardless of how it arrived.
An object resynchronized or replaced after deletion has a different identity
and must never be removed by the old tombstone. R2 has no conditional delete,
so purge must re-check identity immediately before each delete and treat the
remaining race as a deployment risk requiring staging fault injection and
audit monitoring.

`R2_PURGE_ENABLED` defaults to `"false"` and the scheduled Worker only invokes
purge when its value is exactly `"true"`. Keep it false until staging validates
that resync, direct-upload, preview, transfer, and purge operations are
serialized or mutually excluded for a tombstoned scope, including fault
injection across the final HEAD-to-DELETE interval. Enabling purge requires
explicit production approval after audit alerts, restore procedures, and a
rollback drill have been verified; deployment alone must not enable it.

Reconciliation is a repair-and-hold mechanism, never a deletion authority. It
may restore missing index relationships, mark stale or missing records, and
create alerts or operator-review holds. It must not delete R2 objects or derived
artifacts, revoke shares, or purge ambiguous data merely because a scan
disagrees with D1.

This remains an outstanding code gate: `reconcileFileIndex` currently contains
automatic share revocation after a missing-object grace period and automatic
deletion of preview-artifact relationship records from D1 after a missing-source
grace period; it does not delete the R2 preview objects in that branch. Those
actions must become hold/alert-only or move behind a separately approved,
ownership-protected lifecycle action with focused tests.

Lifecycle acceptance:

- exact file and nested prefix delete, restore before expiry, repeat restore;
- idempotent repeated purge and recovery after interruption;
- source replaced with the same key but a new ETag before purge;
- new child added beneath a tombstoned prefix;
- directly uploaded source with and without registered previews;
- manifest, thumbnail, poster, and temporary artifact relationships;
- partial listings, duplicate/out-of-order create/delete events, and deletion
  while a preview or transfer job is running;
- authorization cannot cross division/prefix ownership;
- ambiguous data is retained and alerted, never automatically deleted.

## Event-driven preview design (deferred)

Implementation is intentionally deferred. The target architecture is R2
object-create notifications to `ltds-file-events` as the primary trigger,
with the existing isolated home-server producer as a fallback.

Preview absence is not a delivery failure for non-previewable content. Preview
generation and preview acceptance apply only when a source is explicitly
classified as supported media within configured byte, pixel, page, and duration
bounds. Unsupported media, ZIPs, raw/dump content, and opaque files retain
download/copy delivery without a preview job. The UI must show an honest
non-previewable state rather than retrying or showing a broken preview.

Direct R2/S3 uploads are a later fallback requirement. Until object-create
notifications and an idempotent consumer are separately implemented and
enabled, directly uploaded objects may be indexed by conservative reconciliation
and may rely on the home-server producer for supported previews. This fallback
may repair visibility/index state and enqueue or alert for eligible missing
previews; it must not infer ownership, generate recursively, or delete an
object. Direct-upload preview automation is not currently production-ready.

The queue consumer must:

- accept only delivery-eligible, explicitly previewable source objects;
- reject every exact path segment for Dump, Archive, raw, temporary, trash,
  recovery, `_ltds`, and `.previews`;
- acknowledge generated preview events without recursively generating more;
- deduplicate by source key plus R2 ETag/version and use a single active
  source-to-preview job relationship;
- re-check the live source identity and tombstone state before work, before
  publishing a manifest, and after publishing derivatives;
- bind derivatives to the parent source/job manifest and publish the manifest
  last;
- tolerate duplicate and out-of-order create/delete events, deletion races,
  retry delivery, and a configured dead-letter queue;
- emit structured counters for eligible, ignored, duplicate, queued,
  completed, failed, deleted-race, retry, and dead-letter outcomes.

Images should prefer Cloudflare image transformations only after staging proves
format support, output-size bounds, access controls, and acceptable billed
usage. Video may use Stream only when its account, token, signed-delivery
configuration, limits, and budget are present. PDF/other media stays on the
sandboxed producer path until a bounded Worker-safe implementation exists.

Cost controls include maximum source bytes/pixels/duration, queue batch and
retry limits, per-tenant concurrency, daily transformation/minute budgets,
derivative byte caps, and lifecycle retention. Acceptance must inject duplicate
events, old ETags, deletion during processing, poison messages/DLQ, missing
bindings, unsupported media, and generated-output events.

## Archive security invariant

The current Workers create stored ZIP/ZIP64 delivery archives from already
authorized R2 objects and stream those archives to clients. They do not extract,
decompress, recursively inspect, or trust paths from client-supplied archives.
Consequently there is no server-side ZIP expansion sink at which an expansion
ratio or nested-archive limit would apply, and legitimate ZIP files remain
ordinary opaque delivery objects.

Any future archive extraction or content-inspection feature must introduce a
single sandboxed boundary before extraction and enforce, before writing output:

- normalized relative paths only; reject absolute, drive, UNC, traversal,
  duplicate/ambiguous Unicode, symlink, device, and special-file entries;
- bounded compressed input, entry count, metadata/name bytes, nesting depth,
  per-entry expanded bytes, total expanded bytes, and expansion ratio;
- streaming accounting that aborts as soon as any bound is crossed;
- isolated temporary storage, CPU/memory/time/process quotas, no network, and
  cleanup after success or failure;
- focused tests for nested archives, extreme ratios, excessive entries,
  pathological metadata, traversal, and a representative legitimate archive.

Do not reject a file merely because it is a ZIP when no server-side extraction
is requested.

## Monitoring and external prerequisites

Required dashboards/alerts:

- Worker 4xx/5xx by stable error code and route;
- Workflow queued/running/failed/age, retry exhaustion, and orphaned multipart
  state;
- Queue backlog, oldest message, retry rate, and dead-letter count;
- D1 write/read errors and migration version;
- R2 Class A/Class B operations, stored bytes, temporary bytes, and egress;
- OAuth starts/callbacks/denials/replays without logging state or tokens;
- purge eligible/completed/blocked/ambiguous counts;
- preview eligible/completed/failure/DLQ counts when that design is enabled.

External prerequisites are the exact provider application/callback/scopes,
runtime secret names, non-secret client IDs and disabled-by-default flags,
isolated D1/R2/Workflow/Queue bindings, queue retry and DLQ policies, R2
notification filters, CORS origin/header policy, paid-plan limits where
required, budget alerts, and operator access to logs and rollback controls.
Their presence must be verified from the deployed version; source files and
documentation are not evidence that production is configured.

## Prioritized seven-day readiness plan

Day 1: contain release risk and record reality

- preserve the accepted Delivery deployment; make no production mutation;
- capture live versions, routes/domains, bindings, migrations, compatibility
  dates, flags, health results, and recent safe-error logs;
- record Git integration settings and choose the deliberate deployment model.

Day 2: provision isolated staging

- create separately named staging Workers, hostnames, Access apps/audiences, D1
  databases, R2 buckets, queues/DLQs, and Workflows;
- populate a resource inventory with owner, account, retention, budget, backup,
  and deletion-protection details; reuse no production resource IDs;
- create separate provider test applications only when scheduled, keeping all
  provider flags disabled.

Day 3: codify release gates

- add validated staging configuration and fail-closed preflight, migration,
  smoke-test, and rollback commands;
- make CI build/test without deploying and require reviewed pinned artifacts;
- prevent topic branches from receiving production traffic before validating
  the control with a no-op documentation branch.

Day 4: authorization and lifecycle audit

- enumerate every read/range/preview/import/export/upload/delete/restore/purge
  route and verify server-side role, division, client/share/job, object-prefix,
  and operation checks with cross-tenant negative tests;
- change reconciliation to repair/hold-only and test missing, ambiguous,
  identity-changed, and directly uploaded objects;
- verify retention deadlines, holds, restore authorization/idempotency, backup
  consistency, and permanent purge remaining disabled.

Day 5: isolated staging deployment

- back up staging D1, apply staging-only migrations, and deploy the pinned
  commit with all providers and purge disabled;
- record versions/bindings and run baseline Delivery, Operations, Ops Sync,
  Access, R2 range/download, direct-upload indexing, and restore tests.

Day 6: fault injection and observability

- exercise interrupted transfers, retries/cancellation, test OAuth
  denial/replay/revocation, changed ETags, deletion races, reconciliation
  disagreement, rollback, and restore;
- verify Worker, Workflow, Queue/DLQ, D1, R2 cost, OAuth, purge, and
  reconciliation hold dashboards and alerts;
- apply preview tests only to supported previewable media and verify unsupported
  content remains downloadable.

Day 7: decision packet

- rerun checks/tests/builds from the pinned commit and publish staging evidence,
  limitations, rollback record, resource inventory, and cost/budget owners;
- hold production unless release controls, staging isolation, authorization,
  repair-only reconciliation, restore safeguards, monitoring, and approvals pass;
- request one explicit production decision for the pinned baseline. Provider
  enablement and permanent purge remain separate decisions.

Exact external decisions/resources needed are: acceptance of one Git deployment
model; Cloudflare authority to inspect and later change build settings; unique
staging Worker names and hostnames; unique Access applications/audiences and
test identities; staging D1/R2/Queue/DLQ/Workflow resources; scoped staging
deployment and observability credentials; backup storage and retention/hold
policy owners; alert destinations and cost budgets; and, only for later provider
testing, separate staging OAuth applications, callbacks, scopes, and secrets.
