# Incoming uploads with TrueNAS Cloud Sync

Status: implementation in progress, not an activation checklist that has passed.
This is the intended rclone-native contract. Do not switch production paths
until the matching promotion, download, recovery, and browser tests pass.

## Local implementation checkpoint

The pure naming/multipart planner and bounded basic-validation helper are
implemented. Their focused suites plus the existing Incoming security suite
pass 16 tests. These cover identity changes, incomplete samples, blocked
signatures, duplicate filenames, Windows device aliases, Unicode basenames,
and multipart size boundaries. Operations type checking also passes at this
checkpoint. This does **not** prove the promotion runtime, request wiring,
historical-upload recovery, or production TrueNAS pickup; those remain pending.

The subsequent local increment registers a disabled-by-default promotion
Workflow, bounded segment dispatch, and staff detail/download integration.
Seven focused promotion/planning/status/workflow suites pass 56 tests; a
separate staff-route/read run passes 21 tests. The promotion test bundles the
actual module into a Worker isolate and exercises a multi-part R2 object,
destination proof, and removal without recreation. These are isolated test
resources, not evidence of production pickup.

Upload completion now persists a deduplicated dispatch intent before starting
background work. Repeated completion requests reuse that intent. The existing
consolidated schedule discovers at most ten eligible historical uploads and
drains at most ten intents per invocation. Continuation segments also persist
their intent before dispatch, so a dispatcher outage does not erase the next
step. Leases and bounded retry/backoff prevent duplicate starts and surface
unconfirmed dispatches for attention. The gate-disabled path does not access
the new tables. Local integration checks passed 28 tests across the workflow,
outbox and staff routes, followed by 15 upload-route/workflow tests including
enabled/disabled completion and continuation persistence before an outage.

Staff recent/list/detail views now project promotion and dispatch-attention
states with a bounded D1 query, without fetching object bodies. The focused
staff-route/summary/status run passed 29 tests and type checking passed.

Dispatched jobs now have bounded, fair status reconciliation: authoritative
errored/terminated/paused states become actionable; transport failures remain
retryable, and neither restarts nor republishing are inferred. Publication also
checks the upload retention deadline independently of delayed cleanup jobs.

The pure ZIP metadata parser was rewritten after review found incorrect ZIP64
arithmetic and path handling. A focused parser/reconciliation run passed 17
tests, including a virtual directory beyond 4 GiB, metadata/entry limits,
UTF-8 names, implied/explicit folders and unsafe/conflicting paths. It reads
bounded metadata only; legacy non-UTF-8 names and unsupported structures return
a browsing limitation, never an antivirus verdict or a pickup rejection.

The authorized ZIP adapter and browser wiring are now local: every bounded
range rechecks authority and exact destination identity; the final response
rechecks both, and pagination binds the upload/object version/path/search.
Only immediate folder children are listed. The read/staff-route run passed 24
tests, and focused desktop/mobile browser coverage passed 12 tests, including
basic-ready browsing without automatic download. Scheduled retention now
durably expires aged uploads, releases quota idempotently, and aborts known
multipart work in bounded, fairly rotated batches. It never deletes ready or
quarantine objects in Worker code; physical deletion remains bucket-policy
owned. Focused retention/read tests passed 15 tests after moving cursor
validation ahead of archive byte reads. A fresh full Operations suite is in
progress, not yet a passing release gate. Bucket ready-prefix expiry setup and
production acceptance remain outstanding.

## Retention rollout requirement

Keep application access bounded by the existing 14-day upload deadline. Before
activation, verify an automatic R2 expiry policy for the exclusive `ready/`
prefix (14 days from object publication), preserving any other bucket rules.
Rclone MOVE remains the normal cleanup mechanism. Object-age expiry is the
fallback when the server is offline; it is not a pickup receipt. This avoids
an application-level HEAD/delete race and indefinite retained ready objects.
Only the promotion service may publish this prefix; no other writer may replace
an upload's ready key. Preserve staging until accounted for under its existing
retention policy, and abort known multipart work after a durable expiry fence.

`INCOMING_RCLONE_PROMOTION_ENABLED` remains `false` in checked-in configuration.
Do not enable it solely because the Workflow binding exists or its unit tests
pass. Regenerate Worker types whenever the binding/configuration changes.

The publishing journal must distinguish an attempted publication from a
confirmed ready object. A failed or lost completion response must not be
reported as a successful server download or retried into a duplicate release.

## Ownership

Operations receives uploads and performs bounded basic validation. TrueNAS
Cloud Sync runs rclone hourly to pull ready files. No custom scanner, callback
script, or additional container is required on TrueNAS for this mode.

Basic validation checks upload ownership, multipart completion, declared size,
and blocked file signatures. It is **not malware scanning** and must never be
displayed as an antivirus verdict. Archives are not automatically extracted.
Upload contributors remain write-only: they cannot list or download uploads.

The existing scanner/receipt mode remains a separate supported contract during
migration. Do not repurpose its verification proofs or manufacture receipts for
historical uploads. Database changes must be additive.

## Object publication

1. Receive multipart data under an opaque private staging key.
2. Validate the exact completed object and record its identity.
3. Publish a collision-isolated ready object using bounded, retryable multipart
   work. Never buffer a whole large upload or perform an unbounded post-response
   copy. Preserve the staging object until publication is accounted for.
4. Expose only `ready/<request-id>/<upload-id>/<safe-original-basename>` to the
   TrueNAS task. A display name is not an authorization or storage-path key.
5. Record publication durably. A retry must not recreate a ready object that
   rclone has already moved, including after an ambiguous completion response.
   If publication cannot be distinguished from removal, show an actionable
   uncertain state rather than blindly republishing or deleting the source.

Names must be compatible with Windows consumers, including reserved names,
control characters, separators, trailing spaces/dots and Unicode length.
Separate upload IDs isolate repeated filenames. Preserve the original name in
display metadata. Do not invent organization folders from contributor names.

## TrueNAS task

### Confirmed existing task (September 9, 2026)

The operator's screenshot shows bucket `ltds-incoming`, remote folder `/`,
PULL/MOVE, enabled hourly at the start of each hour, and local destination
`/mnt/L.T.D.S./Drone_Jobs/Incoming Job Data`. There is no server-side scanner
or pickup callback. This root selection explains how internal quarantine keys
can reach local storage before the application finishes verification.

Keep the destination, schedule and transfer direction/mode. Coordinate changing
only the remote selection to `ready/` before enabling the application gate.
While waiting for that rollout, ask the operator to temporarily disable this
one root-level Incoming task, preserving its configuration and local files.
Leaving root MOVE scheduled can remove newly completed staging objects before
publication. This is a temporary pickup pause, not permission to delete files
or disable unrelated TrueNAS tasks. Re-enable the hourly task only after its
ready-prefix selection and the application publication path are verified.
An already downloaded opaque object may be the original upload, not disposable
temporary data; do not delete it based on its name. Once MOVE removes it from
R2, the application cannot recover or verify the local copy without separate
operator confirmation.

The intended task remains **PULL**, **MOVE**, at the start of each hour, using
the existing local destination. Once rollout is verified, select the remote
`ready/` folder instead of the bucket root. Never pull the staging/quarantine
prefix. A root-level MOVE can remove staging objects before validation or
publication and copies opaque internal paths into the destination.

The application does not change the user's TrueNAS schedule. Coordinate the
source-folder switch before activating ready-object publication. Do not delete
previously downloaded quarantine folders or original uploads as part of this
change. Confirm local copies separately before any cleanup.

## Staff browsing and truthful status

- Basic validation passed and the exact ready object is present: available in
  R2 for an explicit authorized attachment download and server pickup.
- Promotion queued/running/retrying: not ready yet; show bounded progress and a
  safe reason, not an indefinite scanner state.
- Ready object absent: no longer available in R2; server delivery is unconfirmed.
- Retention expiry recorded by Operations: expired, not downloaded.
- Basic validation rejected: rejected, with a safe reason; never published.

Rclone MOVE deletes its remote source after its transfer, but Operations has no
server receipt. Object absence alone must not be called successful local
delivery. COPY and MOVE both remain expressible without changing that rule.
Staff download/ZIP inventory must recheck current object identity. A download
can become unavailable when MOVE removes the source; do not promise browser
resume after that removal. Do not automatically download source bytes just to
open a list or detail page.

## Required acceptance before activation

- New upload, duplicate name, safe Unicode/Windows filename, and large upload.
- Failed part, stale object, revoked request, expired upload, and retry after
  each durable-state boundary.
- Completion response lost; database receipt lost; ready object moved before
  recovery; no second publication or false delivery claim.
- Existing pending uploads recover only while their exact source still exists.
- Staff list/search/detail/download and archive navigation remain authorized;
  public contributors cannot read or enumerate ready files.
- Retention and cleanup preserve recoverable sources and do not delete unrelated
  paths; the original TrueNAS task is verified against `ready/` before activation.
