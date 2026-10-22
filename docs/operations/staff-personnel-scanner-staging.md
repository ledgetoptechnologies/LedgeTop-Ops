# Dedicated personnel scanner — staging handoff

Source only: no live service, policy, credential, bucket or NAS changes. PR 242
remains draft. `STAFF_PERSONNEL_ENABLED` remains absent/default-off.

## Protocol and correctness

Ops migration 0226 queues quarantined documents. One job is claimed atomically
for ten minutes. A worker ID cannot accumulate another live lease. Only the
claim-token SHA-256 is stored; the plaintext token is returned once. Expired
leases can be reclaimed with a new token. Content, retry and receipt calls
require both the dedicated scanner bearer and current claim token. The final
SQL audit transaction checks the lease again. Stale workers cannot accept jobs.
Eight unsuccessful attempts lead to manual review; no automatic acceptance,
purge or unsupported manual bypass exists. Job state and fixed error codes are
visible to authorized personnel administrators without exposing claim secrets.

The consumer verifies exact bytes and independent SHA-256, validates the supported
format in an isolated child, runs ClamAV, then submits engine/definitions/policy
provenance. ETag alone is insufficient: the immutable R2 object version is pinned
at upload completion and carried through claims, HEAD/GET and receipts. Same-byte
overwrites still conflict; mismatched GET bodies are cancelled before release.

## Validation policy

PDF parsing uses hash-pinned pypdf in strict mode, rejects encryption, active
actions, JavaScript, XFA and embedded-file structures, and bounds pages, objects
and expanded streams. PNG/JPEG use hash-pinned Pillow, bounded pixels and single
frames. Text must be UTF-8 without unsafe controls.

DOCX/XLSX are bounded Office packages, not arbitrary ZIP uploads: at most 500
entries, 8 MiB per part, 64 MiB actual expanded bytes, bounded compression ratio
and XML nodes. Invalid paths, duplicates, encryption, nonregular entries, embedded
archives/binaries, macros/ActiveX, external relationships, unsafe XML entities,
Word fields, active formulas and unknown Excel functions are rejected. Main types
and relationships must match the declared Office type. This conservative policy
can reject legitimate advanced Office files; review must not bypass quarantine.
These checks supplement AV; they do not prove all malicious files detectable.

The parser child has a 512 MiB address-space limit, 20-second CPU limit and
30-second wall deadline. ClamAV has its own 180-second process deadline plus
file/scan/recursion/time bounds. Explicit heuristic alerts and
`--alert-exceeds-max=yes`, `--alert-encrypted=yes`, `--alert-macros=yes`, and
`--alert-broken-media=yes` prevent silent supported-limit skips becoming clean.
ClamAV exit 2, timeouts, parser unavailability and stale definitions stay in
retry/quarantine. Deterministic file-policy or AV detection rejects the file.

## Isolated service source

`scripts/personnel-scanner/Dockerfile` pins the verified official Python base
digest and exact Python wheel hashes. The local image installed ClamAV 1.4.4.
Review the resulting image/package inventory before publication: this increment
does not publish a registry image.

`deploy/personnel-scanner.compose.yml` is intended for 192.168.50.90. It uses a
dedicated non-root identity, read-only root, no capabilities, no-new-privileges,
bounded CPU/memory/PIDs, tmpfs scratch and its own named signature volume. It
exposes no port and mounts no NAS, employee or client folder. It receives no S3
credentials and never promotes or deletes the original R2 object. Do not attach
Incoming pickup volumes, buckets, mounts or secrets.

Freshclam must complete before the first claim and hourly afterward. The loaded
definitions' build time is checked separately: older than 48 hours or implausibly
future definitions fail closed. Refresh failure prevents claims. Worker crashes
or lost responses recover through lease expiry. Logs contain fixed event/error
codes, never document names, bytes, tokens, credentials, keys or server bodies.

## Required operator configuration

No `.env` file is required. Compose contains the approved nonsecret staging origin
and worker ID directly. Each replica needs a distinct worker ID.

Ops staging is protected by Cloudflare Access. A dedicated, explicitly provisioned
Access service identity and policy for only `/api/staff-personnel/scanner/*` remain
a provisioning gate. Never reuse human cookies, PA keys, Incoming pickup or other
service credentials, and never bypass Access through a development host, direct IP
or broader existing policy. Existing human Ops policies remain separate. This
change creates no policy or credential.

The consumer supports dedicated origin-bound `CF-Access-Client-Id` and
`CF-Access-Client-Secret` in addition to its scanner bearer. Credentials are sent
only to the exact allowlisted staging HTTPS origin with certificate/hostname
verification. Redirects, including login, are hard failures. Ambient proxies
are not used.

After separate authorization, privately provide these Git-ignored files in
`deploy/private/`, accessible only to the service and readable by container UID
10001 through Docker secret mounts:

- `personnel-scanner-token.txt`: matches the dedicated Ops scanner secret.
- `personnel-access-client-id.txt`: dedicated path-scoped Access identity.
- `personnel-access-client-secret.txt`: its secret.

No file or secret value is created or printed by this patch. Apply migrations
0225 and 0226; bind the new private personnel R2 bucket; review explicit native
personnel delegations; configure the scanner secret; then perform the reviewed
staging activation. Never bind Client `DATA_BUCKET`. The Compose parses with
`docker compose -f deploy/personnel-scanner.compose.yml config --quiet` without
starting anything. Building source is not authorization to activate it.

## Acceptance boundary

Local tests use synthetic identities, files and transport. The isolated actual
ClamAV gate downloads official definitions and exercises clean/EICAR decisions,
consumer validation/digest/verdict orchestration and the engine recursion-limit
rejection. The default container unit suite disables networking and explicitly
skips that separate actual-AV gate. No personnel content or EICAR file is written
to a host folder.

Live Access-to-Ops-to-private-R2 acceptance remains unverified. Before enabling
staging, test synthetic upload, lease, exact content, independent validation/AV,
receipt and authorized admin download. Include EICAR, expired/reclaimed leases,
scanner outage, stale definitions, wrong profile/role, same-ETag version changes,
HEAD/GET races, upload/archive race, restart and manual-review visibility. Verify
employees, clients, public links, PA and Windows file roots cannot access these
records. Claude's Documents UI and live staging operator acceptance remain open.

October 22 local evidence: full Ops TypeScript check passed; personnel and exact
migration-inventory suites passed 50/50 groups (16 personnel, 34 inventory;
90.06 seconds). The network-disabled scanner suite passed nine tests with one
explicitly skipped real-AV gate. The separate actual ClamAV gate passed in
54.429 seconds, including clean/EICAR processing, real nested recursion-limit
rejection, and the consumer orchestration using synthetic transport. All 226 Ops
migrations applied to fresh local D1 with zero foreign-key violations. Compose
configuration parsed successfully. Machine-readable source hashes and exact
scope are in `docs/staging/staff-personnel-documents-evidence-2026-10-22.json`.
