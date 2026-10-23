# Windows files: staging activation and acceptance

This packet prepares the first real desktop-to-service acceptance. It does not
authorize production activation or claim deployed Windows application routes. Use only
synthetic data and explicitly reviewed staging identities. Never access TrueNAS
or NAS paths, including NAS mounts on the staging host.

## Current staging checkpoint: October 23, 2026

The active PR250 candidate is `cf455027d517aee56a90537c40f365f077dca4ae`.
It includes the four review repairs in `15c5995a` and a merge of current main;
the App/Core tree is unchanged by that merge. The repaired App suite passed
43/43 groups, Sync access/lifecycle tests 44/44, mounted Ops lifecycle tests
12/12 and the combined readiness/deployment suite 99/99. These are source-test
results, not installed-package or deployed-service acceptance.

At the last observation, eleven of twelve exact-candidate hosted checks had
passed. General CI run `39963300995` still had the Operations test job running;
Windows run `39963301002` and gateway run `39963301052` had succeeded. Re-read
the actual checks before using this checkpoint; an earlier green candidate is
not evidence for this head. EH task `ceff196b-0f59-420a-b21a-ec89c098ba60` now
has this candidate at revision 9, in review with no formal verdict. The owner
candidate update was completed through the supported operation. Execution
admission remains outstanding; recorded host tests are not EH execution.

A distinct synthetic gateway is now running on the allowed staging server's
local disk, with the human-approved exact HTTPS route
`https://employee-gateway-staging.ledgetopdroneservices.com/v1/read`.
Public HTTPS checks verified unsigned refusal, off-route refusal, a signed
manifest, the full 2 MiB fixture and a resumed byte range with matching SHA256.
It contains no NAS or real client data. Its gateway ID is
`5cf305f7-57e7-49ba-b534-730997999331`, with root ID
`4632b5cc-9564-4cda-afc8-3a053fdd7e30`. This running service is separate from
the earlier disposable smoke container that was cleaned up. It has not been
enrolled through an Ops file grant, and the full desktop-to-deployed-Ops/portal
acceptance remains unverified. No gateway secret is included in this document.

The five Windows suffix migrations remain pending in the last schema receipt;
the separate 0225 staff handoff must not be silently added to that window.
Paired staging application routes remain inactive. Preparation helpers now
preserve captured live variables and explicitly inherit existing bindings;
see `windows-files-staging-inherited-upload.md`. Their 61/61 focused tests and
actual captured-input check do not prove an upload, opaque asset association,
physical resource identity, current settings freshness or promotion approval.

Recovery is still a gate. The installed Wrangler's read-only Time Travel
command was rejected at its preliminary database-metadata GET with error
10000, before requesting a bookmark. A fixed `SELECT 1` through the same
identity and pinned Ops binding succeeded with zero changes. This does not
prove global session expiry or establish a recovery checkpoint. No alternate
identity, database write, restore or migration was attempted to bypass it.

This checkpoint supersedes the candidate, task, gateway and access-state
statements in the historical notes below. Every observation must be refreshed
at the actual activation window. No section grants execution permission.

## Historical preparation and qualification notes

PR250 is the active integration review. Its older pushed head `61c8cbbf`
passed Windows, gateway and nine general CI jobs, but Operations tests failed
because the reviewed migration inventory omitted the newly added 0225. The
two-line correction `c8b61289` preserves the inventory guards and has passed
the focused contract, mounted lifecycle and readiness checks. All 14 affected
historical files finished successfully: 102/102 tests. Do not treat the old CI
run as green; the complete combined source still needs a fresh hosted run.

The independently tested desktop repair `a6e735f4` includes Core reservation
`a3080c8d`, host stop-intent ordering and per-invocation active ownership.
Its exact-source App run passed 31/31 synthetic groups; the unchanged Core
passed 103/103. These source repairs do not qualify a previously built package.
The selected-source backend `61a6dde1` passed 32/32 App groups and independent
source review. Its client mode constructs no employee adapter; employee mode
constructs no portal adapter. The two-argument constructor defaults to client.
These tests use inert helper bytes and synthetic adapters, not live sign-in.
Claude's startup selection `7bc047a7` is now integrated in `3250e1ed`, which
passed independent source review and a serialized 38/38 synthetic App run.
Selection precedes authentication; switching stops and saves the prior view
before opening the other source. Preferences select an offered mode and grant
no authority. This supersedes the pending startup implementation status, but
does not establish installed-package or live sign-in acceptance. Combined-source
person pairing remains unqualified; the app uses one source at a time.

The existing EH task `ceff196b-0f59-420a-b21a-ec89c098ba60` was observed at
revision 6 with the older candidate `efb1ce96`, in review and owned by Codex.
No supported owner-candidate update operation is exposed in this connection.
PR and knowledge evidence track the newer inputs; they do not update that task
or grant execution. Reconcile the task through a supported control path before
EH execution. Execution/autonomy remain disabled.

Completed baseline-only replay and private selected-definition comparison are
recorded in `staging/windows-selected-schema-attribution-2026-10-22.md` and its
safe JSON companions. All 46 changed application definitions are now attributed
to 40 whitespace differences, three comment differences and three exact bounded
conditional-RAISE syntax relations. The last three preserve every predicate,
surrounding active token and error-message literal. The classifier deliberately
keeps its original unresolved category and false historical/semantic flags;
this is evidence for review, not automatic schema admission or permission to
ignore a digest mismatch. The five platform/staging object presence differences
now have exact source-shape attribution in
`staging/windows-platform-schema-source-attribution-2026-10-22.md`: local
metadata and observed KV shapes match pinned upstream constants, and the extra
Ops ledger matches the repository's named Wrangler ledger shape. Their actual
history and contents remain unverified and require baseline review; none are
excluded from the original comparison.

Latest qualification: the source-only combined candidate now has real full
Client-to-Ops Workerd RPC and full Ops-to-Python gateway transfer acceptance,
including native content-length framing and explicit server-rejection abort
cleanup. Those newer tests supersede the transport limitations of the earlier
Node adapters described below; their exact scope is in
`staging/windows-current-main-integration-2026-10-22.md`.

A fresh read-only control-plane observation at 2026-10-23T05:11Z found the same
paired active versions, complete ledger hashes and schema hashes as the earlier
receipt, with zero foreign-key violations. All five Windows suffix migrations
are still absent. The concise refresh receipt is
`staging/windows-staging-preflight-refresh-2026-10-22.json`; the October 23
refresh is retained in EH knowledge
`windows-download/staging-readonly-refresh-2026-10-23.md`. It does not attest
historical migration SQL/data effects or an atomic snapshot. No runtime or
database change occurred.

The native staff lifecycle successor 0225 is also absent from that observed
ledger. The existing Windows preflight's declared suffix stops at 0224; it does
not qualify the separate native staff handoff, cutover control or reviewed
production packet. Do not apply additional migrations merely because a source
file exists or the Windows suffix is pending.

The standalone employee and portal handlers have local joined acceptance, but
the application entrypoints do not mount them. The earlier staging gateway
receipt proves an isolated container test with no network or host mounts; it is
not a listening service. The desktop integration has synthetic acceptance, not
a real human sign-in result. Local checks do not satisfy required hosted merge
checks. The earlier GitHub billing restriction has cleared: hosted Windows,
gateway and MCP checks passed on `e68e2adc`. These are baseline observations;
the final candidate's complete hosted suite remains a merge gate.

A separate opt-in local transport acceptance now connects the
actual .NET portal client and downloader over loopback TLS to the existing
Client routers and real local D1/R2. A 2 MiB synthetic download was interrupted
after 16,384 bytes, resumed with HTTP 206 and passed its final SHA-256 check.
Revoking the delivery through the actual Ops issuer made the saved handle return
404 without another R2 read, even while the Client grant remained active. The
test uses the real local Ops reader. Incorrect TLS pins and invalid RS256
signatures were refused. Identity bootstrap, PA acknowledgements, JWKS discovery,
the token helper and direct-function service bindings remain test fixtures.
See `docs/staging/windows-local-client-transport-2026-10-22.md`.

The separate employee acceptance connects the actual .NET employee client to
the Ops router and native admission/grant records, then through a signed TLS
adapter to the Python gateway's HTTP server. The same 2 MiB interruption/resume
passes; cross-user, traversal, stale-version and revoked-grant requests are
refused. No gateway calls follow revocation. The disposable container holds only
its own synthetic files in tmpfs and has no host mounts; its ordinary Docker
bridge permits outbound traffic and publishes inbound HTTP only on loopback.
See `docs/staging/windows-local-employee-transport-2026-10-22.md`.

The opt-in large employee run also passed with 3 GiB + 17 actual bytes,
interrupted and resumed at byte 2,148,532,241. It uses a new plain local Docker
volume for owned synthetic source/snapshots, checks disk capacity before writing,
streams generation and verification, and leaves product deadlines unchanged.
The final large run and ordinary 2 MiB regression both passed; revocation,
cross-user and stale-version refusals remained effective. This does not qualify
30 GiB files, a deployed proxy or live R2. See
`docs/staging/windows-large-employee-transport-2026-10-22.md`.

A historical unsigned construction validates 522 payload files after pack/unpack,
including .NET, helper-module and Go runtime notices. An offline App Installer
preview is bound to that actual package identity and SHA-256; its positive and
20 refusal cases pass. It deliberately uses reserved `.invalid` URLs and cannot
activate an update channel. Neither artifact is signed, installed or published.
It was rebuilt from exact reviewed app source `6a87b077`, including the portal
metadata deadline fix. See
`docs/staging/windows-current-source-package-preview-2026-10-22.md` for the
that checkpoint's package and descriptor fingerprints; older construction/signing evidence
retains its explicitly older input.

A later unsigned construction at source `2df58a6e` and its descriptor checks are
recorded in EH knowledge. Both constructions predate the current Core/App queue
repairs. Rebuild and requalify the final payload before signing or publication;
neither an old artifact hash nor a passing synthetic App suite establishes that
the installable package contains the newer source.

Neither acceptance proves deployed staging, actual human sign-in, live R2,
Engineering Hub execution, a signed installation or Cloud Files hydration.

Prepare and review a staging-only composition before changing runtime routing.
An executable, offline paired entry-module/config constructor now exists in
`scripts/windows-files-staging-composition.mjs`, with CLI and static-build
qualification described in `docs/windows-files-staging-composition.md`.
It has not activated either Worker; production mains/configs remain unchanged.
Do not replace production Wrangler configuration with staging values. Keep
Cloudflare build policy at main pushes and PRs. A direct SSH test is not an
Engineering Hub runner execution; runner enrollment is a separate gate.

Source composition now lives in `createWindowsEmployeeFilesStagingRouter`
(`apps/operations/src/worker/windows-files-staging.ts`) and
`createWindowsPortalStagingRouter`
(`apps/client/src/worker/client-portal/windows-files-staging.ts`). These combine
the existing handlers; neither application entrypoint imports them. The employee
factory receives a staging database and private transport configuration. The
portal factory receives reviewed deployment declarations and fixed database/
bucket references, then also enforces the existing native deployment gate on
every request. Declarations and JavaScript object identity cannot verify physical
resource ownership. Deployment tooling must still compare real control-plane
bindings before constructing either factory.

Employee invalid/disabled configuration yields a static 503 without attempting
authentication or storage. Portal malformed constructor declarations throw a
static configuration error; valid disabled configuration returns 503. Both
capture configuration so later caller mutation cannot enable a disabled route
or replace its source identity. No new global environment variables are added.

## Deployment packet

Record these non-secret facts before activation:

- Exact reviewed source commit, immutable build artifact digest and rollback
  artifact; staging hostname and Worker names.
- Actual account, D1 database and R2 bucket identities from the deployment
  control plane. A configuration label or injected object is not proof of the
  physical resource behind a binding. Compare actual service-binding targets
  with the staging Ops Worker.
- Actual migration ledgers and required dependencies. New components need
  Ops 0222/0223/0224 and Client 0235/0236 plus their native authority baseline;
  do not blindly apply a numeric suffix to an unknown database.
- Exact canonical staging Ops and portal origins, Cloudflare issuer and one
  human audience per application. No production origin/audience fallback.
- Gateway UUID, fixed HTTPS backend origin, signing key ID and enrolled root
  generation/fingerprint. Secrets stay in the approved secret store; record
  secret names and rotation identifiers, never values.
- Synthetic staff/recipient/project/folder fixture identities, fixture size and
  expected SHA256, creation commands/receipts and scoped cleanup ownership.

Employee signing, file-handle encryption and queue-reference encryption keys
must be separate. The gateway receives only its signing key. Desktop setup
contains approved origins/helper provenance, never these server secrets.

## Observed staging baseline and migration boundaries

Read-only control-plane inspection on 2026-10-22 found:

| Worker | Active version (100%) | Database |
| --- | --- | --- |
| `ledgetop-ops-staging` | `231fead7-433e-4015-847e-ea9ebda35894` | Ops `78b34173-b168-4e3d-9832-bb9d245cc6b8` |
| `ledgetop-clients-staging` | `6b9f1ff4-ce41-493e-a922-25081c2b67f4` | Client `b6f653ab-9acd-4421-9ad0-207754b59aeb` |

Both Workers bind the staging Client database and `client-data-staging` bucket.
The Client private authorization reader targets `ledgetop-ops-staging`, and its
primary portal is `https://portal-staging.ledgetopdroneservices.com`. The actual
Ops and portal human audiences differ from their known production audiences.
These are observations, not permanent deployment pins; re-read them before use.

Repeat the credential-safe observation with
`npm run staging:windows-files:preflight`. It uses the installed Wrangler
credential provider, validates both Worker versions before fixed staging-only
database reads, and emits no credential values or raw schema/client rows.
Invoking the underlying script without `--read-only` performs no network calls.
Its offline unit tests run in the existing main/PR CI job.

The saved receipt is
`docs/staging/windows-files-preflight-2026-10-22.json`. The completed live run
observed 2,403 Ops and 1,158 Client schema objects and zero foreign-key violations.
Schema reads use bounded 128-object pages, a 32-page cap and unchanged 2 MiB
subprocess output limits. Duplicate objects or a full final page fail instead of
producing a truncated hash. Only hashes and counts leave the schema reader.
The receipt preserves ordered migration names, but explicitly does not verify
the entire earlier canonical history or claim an atomic metadata/schema
snapshot. It is an observation, not migration or deployment authorization.

Read-only ledger queries found Ops through
`0221_portal_correspondence_lifecycle_write_guards.sql` and Client through
`0234_pa_principal_reenrollment.sql`. All five Windows suffix migrations were
absent. No migration or data change was made during inspection. Complete ordered
ledgers and schema still need verification; a maximum prefix alone is not proof.

The proposed order is Ops 0222, 0223, 0224, then Client 0235, 0236. Keep routes off
through preparation. Ops 0223 also adds `employee.files.manage` and its links to
existing owner/admin roles. A preservation check must allow exactly those new
rows while comparing every prior permission and role link unchanged. Management
permission alone does not create a file-read grant. Other suffix effects are
new tables, views, guards and indexes; existing ordinary delivery authorization
and audit remain authoritative for their routes.

These files are not safe to replay blindly: they include non-idempotent ALTER,
INSERT and CREATE statements. Use a reviewed exact-window migration configuration
with ledger reconciliation after each file. The five-file sequence is not one
cross-database transaction. On a failure or unknown outcome, inspect actual
ledger/schema before any retry; never delete a ledger entry to force replay.
Retain a verified restorable staging checkpoint before applying. Keeping the
additive schema with routes off is preferable to dropping durable command/audit
records; restoration or a forward fix needs its own reviewed plan.

The canonical local joined test now rehearses the populated Ops 0221 and Client
0234 baselines before applying this exact suffix. Its expanded run passed in
289.75 seconds under a 360-second deadline for this one test. It compares every
pre-existing application table row and schema definition, permits only the
named migration entries and exact permission/role-link additions, then runs the
native producer, signed human JWT, Unicode catalog, durable reference,
publication refresh, conditional R2 range, audit and revoke checks. For each of
the five files it now forces a late ledger uniqueness failure after the exact
DDL/data and normal ledger insert. Each failed local batch restores the exact
per-boundary schema, every prior application row/grant/ledger and FK0. A successful
commit then deliberately loses its observer acknowledgement; reads confirm the
committed file without replay while retaining each database's independent prefix.
The receipt is `staging/windows-migration-failure-acceptance-2026-10-22.json`.
This uses synthetic local Miniflare D1/R2, not remote client data or a remote
Wrangler apply. It does not simulate an actual socket/process interruption,
qualify remote apply atomicity or a generic reconciler, restore a backup, or
execute the fixture's separate post-ready public-link suite.

Engineering Hub currently reports autonomous execution disabled. Its existing
Windows task is in review with the exact candidate above; there is no execution receipt. Source preparation
and local developer acceptance do not establish the requested EH branch runner
path. Do not bypass that gap with an unrecorded branch deployment.

## Gateway qualification

Read `/home/bkoltz/AGENTS.md` and any applicable service instructions before
host changes. SSH uses `bkoltz@192.168.50.90` with the existing trusted host key.
Recheck realpath, filesystem type, free disk and memory for each owned context.
Previously documented free-space figures are historical; record current
capacity and reserve before fixture creation. A new read-only observation found
8,861,564,928 available bytes on the home filesystem (findmnt: ext4), about
5.4 GB available memory and 17.2 GB free swap. The non-atomic receipt is
`staging/windows-staging-capacity-refresh-2026-10-22.json`; it created no fixture,
accessed no NAS path and does not qualify a future owned context. Large fixture generation belongs
on the approved PC lab, and does not justify pruning unrelated staging data.

Create a unique owned directory on local ext4 for a small synthetic fixture.
Enroll it inside the intended container mount namespace. Source mounts are
read-only; private service configuration/state/spool are separate and owned by
the nonroot service user. Bound CPU, memory, spool, concurrency and logs. Do not
mount `/mnt`, a home directory, a Docker socket or a NAS source into the service.

Provide reviewed private TLS ingress to the configured fixed gateway origin.
The three gateway Dockerfiles now pin the same official multi-platform Python
index; its actual Linux amd64 test image passed 67/67 checks with network disabled,
read-only root, dropped capabilities, nonroot execution and no host/volume mounts.
See `staging/windows-gateway-base-image-provenance-2026-10-22.json`. This qualifies
the tested local base/runtime, not a deployed service or the host's TLS setup.
The service's default loopback HTTP listener is not a public endpoint. Prove
unsigned, wrong-key, expired and replayed requests fail, and that a valid signed
request cannot select an unenrolled root. Record ingress/header/time limits.
Keep existing PA, Viewer, exporter and message-bus services untouched.

## Human acceptance sequence

1. Through supported native staff and administrator flows, establish one
   synthetic exact-root read grant. Registration or an administrator role alone
   must not grant file bytes. Keep command and audit receipts.
2. Establish a synthetic portal recipient, project and folder through supported
   issuer flows. Upload a small checksum-backed R2 object and verify current
   index/version pins. Do not fabricate active authority rows in D1.
3. Use the reviewed desktop branch with trusted setup and the pinned official
   cloudflared helper. Test client mode and employee mode independently, with an
   explicit human sign-in for the selected source. A client must not need staff
   authorization. Verify client mode discovers only portal deliveries and
   employee mode only approved server roots. Switching mode must drain the old
   model and isolate its queue, identity and late callbacks. Do not advertise a
   combined view until reviewed person-pairing evidence exists; matching email
   text or comparing source-specific opaque principal IDs does not prove it.
4. Download through each real deployed route: discovery, durable reference,
   queue resolution, partial data, interruption, application restart, fresh
   identity/manifest, range resume and final size/SHA256. Check that no existing
   local file is overwritten and no token/byte URL is persisted in queue state.
5. Refresh a portal publication while retaining the same grant/mapping. Old
   short selectors must fail; fresh catalog and durable queue resolution must
   retain logical identity only for unchanged content. An omitted then restored
   mapping must not regain continuity.
6. Revoke each grant through its owner and prove new discovery/resolution/bytes
   deny. Test session expiry and switching to a second synthetic human: old
   queue results and callbacks must not appear under the new identity. Already
   downloaded bytes cannot be remotely recalled.
7. Inspect audit receipts and local state, then remove only resources listed in
   this packet's cleanup ownership. Re-read actual deployment settings and
   confirm unrelated services and production routes are unchanged.

Retain a redacted receipt with exact source, deployment, schema, fixture and
desktop artifact fingerprints, test outcomes and cleanup results. Never retain
JWTs, cookies, signing keys or raw credential files in evidence.

## Containment and rollback review

Before execution, freeze the exact paired versions/resources/schema and ledger
observations, prepared modules/configuration, additive migration hashes, TLS
gateway identity, fixture ownership and forward/rollback code artifacts. The
reviewer must address the retained schema-attribution evidence explicitly; do
not normalize or omit objects to turn the comparison into approval.

Keep Windows families disabled until both databases and generated staging
compositions have passed their reviewed checks. On failure, stop new Windows
admissions and restore only the reviewed preceding staging code/route settings;
verify the original non-Windows routes and background handlers afterward. The
first containment path leaves additive schema in place. Do not drop tables,
delete existing records, restore an entire D1 database or revoke unrelated grants
as an automatic rollback. Any data restore needs its own approved recovery
window and coherent state assessment; provider recovery bookmarks alone do not
prove a tested restore or an atomic paired snapshot.

Stop on an unknown migration outcome, changed resource/version/digest or
ambiguous gateway/container state. Reconcile the existing attempt and ownership
before retrying; do not create a replacement test run or bypass EH through SSH.

## Later release gates

This small live slice does not prove existing/multipart R2 checksum coverage,
30 GiB throughput, long preparation/ingress deadlines, atomic historical source
snapshots, clean-machine signed installation/update/uninstall, or Cloud Files
hydration/pinning/eviction. Keep each gate explicit. Employee writes remain
disabled until the preserved-mtime stale-overwrite failure is resolved.
