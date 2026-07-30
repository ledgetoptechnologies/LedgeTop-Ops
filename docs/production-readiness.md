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

Before a staging rollout:

1. Export the Operations and Delivery D1 databases and record the deployed
   Worker version IDs.
2. Apply migrations to isolated staging databases. Never bind staging Workers
   to production D1 or R2.
3. Validate generated Worker binding types and compare every required binding
   with the staging version configuration.
4. Register the exact staging OAuth redirect URI. Wildcards and alternate hosts
   are not acceptable.
5. Provision secrets interactively. Do not place them in build variables,
   Wrangler configuration, CI logs, or tickets.
6. Deploy with provider flags disabled, verify baseline Delivery behavior, then
   enable one provider in staging.
7. Preserve the prior Worker version and D1 exports until acceptance completes.

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

Reconciliation runs weekly as a conservative safety net. It may repair indexes,
mark missing relationships, and create alerts. It must not automatically purge
an unowned, ambiguous, newly discovered, or identity-changed object.

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
