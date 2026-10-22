# Windows files: staging activation and acceptance

This packet prepares the first real desktop-to-service acceptance. It does not
authorize production activation or claim a deployed Windows gateway. Use only
synthetic data and explicitly reviewed staging identities. Never access TrueNAS
or NAS paths, including NAS mounts on the staging host.

## Current boundary

Latest qualification: the source-only combined candidate now has real full
Client-to-Ops Workerd RPC and full Ops-to-Python gateway transfer acceptance,
including native content-length framing and explicit server-rejection abort
cleanup. Those newer tests supersede the transport limitations of the earlier
Node adapters described below; their exact scope is in
`staging/windows-current-main-integration-2026-10-22.md`.

A fresh read-only control-plane observation at 2026-10-22T23:35Z found the same
paired active versions, complete ledger hashes and schema hashes as the earlier
receipt, with zero foreign-key violations. All five Windows suffix migrations
are still absent. The concise refresh receipt is
`staging/windows-staging-preflight-refresh-2026-10-22.json`; it does not attest
historical migration SQL/data effects or an atomic snapshot. No runtime or
database change occurred.

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

The latest unsigned construction validates 522 payload files after pack/unpack,
including .NET, helper-module and Go runtime notices. An offline App Installer
preview is bound to that actual package identity and SHA-256; its positive and
20 refusal cases pass. It deliberately uses reserved `.invalid` URLs and cannot
activate an update channel. Neither artifact is signed, installed or published.
See `docs/staging/windows-go-notices-package-2026-10-22.md` and
`docs/staging/windows-appinstaller-preview-2026-10-22.md`.

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
0234 baselines before applying this exact suffix. Its final run passed in
222.03 seconds under the existing 240-second test deadline. It compares every
pre-existing application table row and schema definition, permits only the
named migration entries and exact permission/role-link additions, then runs the
native producer, signed human JWT, Unicode catalog, durable reference,
publication refresh, conditional R2 range, audit and revoke checks. Foreign-key
checks pass. This uses synthetic local Miniflare D1/R2, not a copy of remote
client data or a remote Wrangler apply. It does not test an interrupted apply,
restore a backup, or execute the fixture's separate post-ready public-link suite.

Engineering Hub currently reports autonomous execution disabled. Its existing
Windows task is unclaimed; there is no execution receipt. Source preparation
and local developer acceptance do not establish the requested EH branch runner
path. Do not bypass that gap with an unrecorded branch deployment.

## Gateway qualification

Read `/home/bkoltz/AGENTS.md` and any applicable service instructions before
host changes. SSH uses `bkoltz@192.168.50.90` with the existing trusted host key.
Recheck realpath, filesystem type, free disk and memory for each owned context.
On 2026-10-22 the root filesystem still had about 11 GiB free; do not create a
30 GiB fixture or prune unrelated data to make room.

Create a unique owned directory on local ext4 for a small synthetic fixture.
Enroll it inside the intended container mount namespace. Source mounts are
read-only; private service configuration/state/spool are separate and owned by
the nonroot service user. Bound CPU, memory, spool, concurrency and logs. Do not
mount `/mnt`, a home directory, a Docker socket or a NAS source into the service.

Provide reviewed private TLS ingress to the configured fixed gateway origin.
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
   cloudflared helper. Explicitly sign in as the human. Verify employee roots
   and portal deliveries are discovered together without workspace switching.
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

## Later release gates

This small live slice does not prove existing/multipart R2 checksum coverage,
30 GiB throughput, long preparation/ingress deadlines, atomic historical source
snapshots, clean-machine signed installation/update/uninstall, or Cloud Files
hydration/pinning/eviction. Keep each gate explicit. Employee writes remain
disabled until the preserved-mtime stale-overwrite failure is resolved.
