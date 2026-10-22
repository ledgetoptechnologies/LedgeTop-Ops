# Windows files: staging activation and acceptance

This packet prepares the first real desktop-to-service acceptance. It does not
authorize production activation or claim a deployed Windows gateway. Use only
synthetic data and explicitly reviewed staging identities. Never access TrueNAS
or NAS paths, including NAS mounts on the staging host.

## Current boundary

The standalone employee and portal handlers have local joined acceptance, but
the application entrypoints do not mount them. The earlier staging gateway
receipt proves an isolated container test with no network or host mounts; it is
not a listening service. The desktop integration has synthetic acceptance, not
a real human sign-in result. Local checks do not satisfy required hosted merge
checks. GitHub currently refuses jobs before execution for account billing.

Prepare and review a staging-only composition before changing runtime routing.
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
