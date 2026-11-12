# Protected transfer executor design and disabled interfaces

**Historical disabled design:** Beau waived staging backups on November 12. Its backup,
vault and recovery-key requirements are not staging gates; do not build more backup
framework or attempt to enable this prototype. Preserve current data and authority and
use Merger's separately reviewed migration procedure. Production backup policy is unchanged.

Owner: Merger performs provider operations, allocation, protected credential/key handling,
export/import, acceptance and cutover. Backend authors own this design and implementation
corrections. The offline interfaces are **not a working provider executor or transfer approval**.
`executeProtectedTransferPlan` rejects unconditionally; no flag, supplied adapter or event
can turn it on. No source data, credential file, key, export URL or provider state was read
to prepare this packet.

## Supported pieces to reuse

- `staging-backup-envelope.mjs`: real bounded AES-GCM-256 envelope and authenticated opening,
  pinned to the two legacy staging source databases and allocated Staging targets. It has no
  persistence or key custody. Use its exact binding/AAD and 32MiB limit; do not weaken them.
- `readCompleteTableSnapshot(tableName, batchReader)` and
  `collectOrderedReadOnlySnapshot(keys, read, { concurrency })`: reusable count/row and ordered
  read verification primitives. Neither provides cross-table/cross-database atomicity.
- `createWindowsDpapiSealer({ powershell })` in `staging-inquiry-custody.mjs`: existing
  CurrentUser DPAPI response-sealing contract, accepting `{ rawResponseBytes, destination }`.
  Its current fixed purpose and one-use inquiry journals belong to earlier operations. Do not
  repoint/replay those journals or treat that sealer alone as independent recovery-key custody.
  A reviewed successor with a distinct backup purpose, private directory/ACL checks and
  recovery semantics would be required before operational reuse.
- `compileStagingV4MigrationPlan` / `validatePreparedStagingV4Plan` /
  `executePreparedStagingV4Step` and connector public-manifest builders are useful contract
  references. Their old targets, history/capsule hashes and consumed journals are immutable.
  They are not new-account executors. See `custody-tooling.md` for exact source paths/limits.

No existing complete consistent encrypted D1/R2 export/import executor has been qualified.

## 1. Consistent D1 export lineage

Cloudflare's current D1 export API uses
`POST /accounts/{account_id}/d1/database/{database_id}/export` with
`output_format: "polling"`. Full D1-compatible export must keep data and schema, without
table filtering or `sqlite3_cli_only`. An active export returns `at_bookmark`; subsequent
polls supply **that same** `current_bookmark`. Completion returns an SQL download capability
in `result.signed_url`. Do not publish the URL, filename or provider message text.

The API warns that exporting can make the source D1 unavailable to queries, and that an
active export must be polled or it cancels. A review of that service window is required;
this is not an innocuous ordinary SELECT. The result URL is documented as valid for one hour.
These are provider protocol facts, not proof an export was started or completed here.
[Export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/).

The two databases are not one transaction. Establish a real **quiet-window receipt** that
fences every relevant writer: Ops, Portal, Sync, PA callbacks, queue consumers, active
Workflows, scheduled jobs, device ingress and other automation. Merger must identify the
actual owners and safe method; do not silently change live feature flags. Capture old and
new exact account/database identities, source binding graph, migration ledgers, source
authority and a consistent reference inventory after writers are quiescent. Keep the window
until both exports and source rechecks complete. A timestamp, read replica bookmark or
independent per-table counts alone is not a cross-database consistency witness.

The provider adapter must seal each raw response **before parsing** and atomically record its
safe receipt. The protected response retains the bookmark/URL for continuation; ordinary
journals contain their private receipt reference/hash only. The export bookmark must remain
constant through polling. Any changed/missing bookmark or unexpected status stops for
reconciliation. A lost initial response cannot be fixed by issuing another initial export.

## 2. Capacity decision and encrypted persistence

Obtain actual export length through the reviewed private transport. D1's allocated/database
storage size does not prove SQL export size. Existing envelope capacity is one nonempty unit
of at most **33,554,432 bytes**. Enforce the limit while reading the body, cancel over-limit
reads and never write plaintext to a temporary SQL file or log. The download adapter must
validate exact reviewed HTTPS origin, reject redirects, keep the signed capability private,
and send no account bearer token/ambient browser cookies to a storage download origin.

If a full export exceeds the envelope limit, stop with a capacity gate. Do not truncate,
silently split arbitrary SQL, sample tables or declare a smaller dataset equivalent. A
reviewed streaming/multipart format must first bind the full source snapshot, ordered part
numbers/count/lengths/digests, whole-payload digest, completeness manifest and restore order.
No such multipart implementation is claimed by this packet. Cloudflare documents SQL import
and reserved-table/format limitations; those do not make arbitrary SQL splitting safe.
[Import/export guidance](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

The persistence adapter must create new files only in an owner-approved private backup root,
reject symlink/junction/hardlink/path escapes, verify restrictive Windows ACLs (or equivalent
reviewed platform policy), write **only authenticated ciphertext**, flush durably, reopen and
hash the exact persisted bytes. It must never overwrite an earlier backup, intent, result or
claim. Metadata manifests/receipts that contain private row/object names must also be sealed.
Keep safe hashes separate from private metadata. A chmod call or file extension is not ACL
or ciphertext verification.

## 3. Independent recovery-key custody and test

Provision an independent staging-backup encryption key through Merger's protected custody
process **before** exporting real data. It is separate from DJI, PA, Viewer, Cloudflare API
and keychain-encryption credentials. Store the recovery material outside the ciphertext
directory and source repository under independently reviewed protected custody. This design
does not pick an unverified vault, read a private credential file or create a real key.

Import a recovered key into a nonextractable AES-GCM CryptoKey only in private memory. The
envelope key ID is a symbolic version, not key material. A newly generated process-local key
without durable recovery is unacceptable: once the process exits its backup would be lost.
DPAPI protection on the same PC is not, by itself, recovery after that PC/user profile is lost.
Merger must approve the recovery authority, protected off-machine/recovery path and rotation
retention. Do not put the recovery secret alongside its encrypted backup or into CLI arguments.

After encrypted persistence, a separate process must use the **approved recovery path**, not
the original cached key/object, to authenticate/open the saved envelope and compare the exact
plaintext digest/length. The recovery test consumes no provider import capability and creates
no plaintext file. Record only safe proof hashes and the reviewed custody version; erase
returned plaintext buffers after checking. This must be demonstrated with a synthetic canary
before real exports. A same-process encrypt/decrypt unit test is not independent recovery.

## 4. Exact import/migration fences and parity

Immediately before each provider action, re-read exact source/target identities and the
reviewed fresh quiet-window/target state. Reject swapped roles, changed database IDs, changed
source snapshots or expired/different control witnesses. Newly allocated targets are not
authority: verify their actual schema/ledger/data state rather than assuming they remain empty.

There is deliberately **no arbitrary SQL API** in these interfaces. A future importer accepts
only the authenticated full export and reviewed source schema plus a pinned ordered migration
plan. It must enforce approved SQL/statement boundaries and D1 reserved-table handling,
rehearse on disposable storage, and validate the actual destination before executing. The
existence of a generic `d1 execute --file` command is not permission to run its contents.

Verify at least these invariants after restore and again after reviewed migrations:

| Scope | Required proof |
| --- | --- |
| Schema | Exact tables/indexes/triggers/views and reviewed SQL/hash comparison; any normalization difference explicitly reviewed |
| Migration ledger | Exact ordered names, applicable body hashes and baseline/suffix relation; no highest-filename shortcut |
| Data/references | Complete approved table counts and canonical private content hashes, FK checks, cross-database root/link references |
| Source authority | Exact source IDs, external identity/namespace, source revisions/sequences/snapshot hashes and current manifest/key commitments |
| People/access | Preserve reviewed native staff/profile/admission/root/membership/grant identities, denies, generations, expiries and revocations; no email-derived admission |
| Durable work | Existing outbox/receipt/idempotency/unknown-operation state and Workflow outcomes reconciled; no replay of consumed work |
| Recovery | Persisted encrypted bytes reopened through independent approved key custody, with matching digest/length and safe proof receipt |

Volatile sessions or other excluded rows require a specific reviewed policy; do not silently
drop them to make counts pass. Adding target-only bootstrap identities/grants is a separate
reviewed operation and must be reflected in expected parity, never hidden as a restore side effect.

## 5. Offline plan/journal interface

`staging-protected-transfer.mjs` compiles only fixed action descriptors from reviewed safe
metadata. It has no SQL, private URLs, provider adapters, secret fields or execution-enable
switch. Action IDs are deterministic for the exact plan hash/step. The journal stores a
bounded event history, expected revisions and safe outcome receipt hashes; state is derived
by replaying/validating the history, never trusted from a caller-provided cursor.
`backupBindingForTransferPlan(plan, role)` derives the exact Operations or Portal envelope
binding from that validated plan, avoiding separately hand-built source/target/migration
context. It returns metadata only; actual envelope round trips are tested with synthetic
RAM keys/data, not private export or independent custody/recovery.

An action must be durably begun before its provider call. Confirmed outcomes advance once.
Each import and each migration has an immediately preceding role-specific fresh-fence step.
Its begin event must carry `controlReceiptSha256` matching that fence's confirmed (or
confirmed-reconciliation) receipt. The future adapter must verify the receipt's actual source,
target and quiet-window readback, expiry and approval at action time; a hash alone is not
freshness or authority. This explicit link does not replace the real per-action re-read.
An ambiguous outcome stops progress and exposes only reconciliation for the **same action**.
A confirmed reconciliation may advance; an unresolved result remains blocked. A confirmed
not-performed result stops the current attempt and requires a newly reviewed successor,
rather than automatically repeating the consumed action. A failed action is terminal.
The plan's final status is ready for **Merger acceptance**, not production activation.

These are reviewable offline state transitions, **not a durable authenticated journal**.
The future operational adapter must supply exclusive/create-new claims, append-only durable
CAS storage, proof custody and readback. A caller can manufacture hashes/events in memory;
those events are not evidence, approval or authorization to run a provider action.

Export polling itself comprises multiple HTTP requests. Its future inner journal must pin
every request/response to the original protected bookmark and complete/unknown outcome;
the abstract export-poll step does not claim that inner adapter is implemented. Polling is
bounded execution of an explicitly started export, not scheduled AI inbox polling. No
unbounded background process, daemon or schedule is introduced here.

## 6. Separate R2 continuity plan and final holds

R2 transfer needs its own reviewed private object manifest and source write fence, including
object key/prefix scope, exact byte counts/body hashes, metadata/content type, source
version/ETag interpretation, multipart state, CORS/lifecycle/notifications and reference
links from both D1 snapshots. Store names/paths and signed URLs only in protected custody.
Do not equate an ETag with a SHA-256 body hash or assume a cross-account copy API preserves
the desired version. Reconcile object changes, omissions and partial/unknown copies, prove
private destination hashes/metadata and test resumed downloads independently. Do not use
this bounded D1 envelope as a 30GiB R2 transfer implementation.

Merger must still review/implement: real quiet-window ownership, private response/download
transport, independent key custody and recovery, private ciphertext/journal persistence,
capacity/multipart decision, exact guarded import/migration adapters, full parity proofs,
R2 continuity, restored source authority, protected Access/provider/app pins, real sign-in /
request / Viewer / revocation acceptance, actual 48-hour frontend asset paths/bytes/catalog,
safe rollback and exact legacy cleanup. The interfaces activate none of those operations.
