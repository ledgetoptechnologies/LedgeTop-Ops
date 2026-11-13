# Inert derivative supplement adapter contract

This source candidate installs no endpoint, dispatcher or default qualifier. It
does not repair a model, run a converter or authorize runtime activation.

## Server identity and producer mapping

`createSupplementQualifier` requires server-owned callbacks for deployment
binding, authenticated producer binding, producer-incarnation confirmation,
converter admission, physical custody and independent verification. Any absent
dependency rejects. A current producer mapping alone cannot prove a historical
incarnation; unknown legacy mappings must fail until an authoritative retained
binding or reviewed adoption establishes the specific target. Client metadata,
hostname, node label or Viewer initialization generation cannot establish it.

The producer read uses the existing NodeODM TLS query-token transport, bounded
JSON, explicit environment, redirect refusal and exact schema/digest checks. The
producer digest proves record consistency, not a signature or fresh byte check.
The resolver normalizes its typed subset and adds the endpoint from configured
server state, never from a Host header or caller URL. Producer generation and
native task UUID remain separate from the persisted Viewer initialization
generation and façade task UUID.

The qualifier derives attempt/version/provider/facade IDs, original archive SHA,
acknowledged initialization generation, registered OBJ/MTL/texture/GLB snapshot
and source manifest SHA from Viewer records. For this first contract, only the
modern archive layout2 with exact input membership in the verified archive
inventory is eligible. Deployment environment and producer mapping must match
the server-owned bindings. The supported coordinate frame is explicitly local,
unknown units and not georeferenced; this contract cannot invent an EPSG/scale.

## Envelope and verification

The strict schema1 envelope contains `identity`, `converter`, `coordinateFrame`,
`files` and `outputManifestSha256`. Identity includes `initializationGeneration`,
`producerGeneration` and `nativeTaskId` explicitly. Converter includes exact
binary/build-info/command SHA and policy revision. Each file has only relative
path, role, safe integer byte size and lowercase SHA256. Roles are render,
private-proof and diagnostic. At most10,000 files/64GiB are admitted; existing
mesh input has its separate16GiB limit. Unsafe paths, case aliases, extra fields,
missing proof and digest mismatches reject. Canonical inventory/envelope hashes
use versioned domain prefixes. Normalized metadata is copied and frozen.

The independent verification callback must produce a matching typed receipt with
all four checks true: geometry, source UV coverage, raw atlas pixels and final
texture relationship. An opaque old v4 geometry/opaque-material audit, a producer
`verified:true` flag or three checks out of four cannot satisfy it. The receipt
binds exact identity/output digest/policy and is copied/frozen; its hash and body
are recorded in the same database transaction as successful recovery completion.
Real verifier implementations are still owned by Processing and uninstalled.

## Physical read custody

`PinnedSupplementDirectory` provides Linux descriptor-relative nofollow reads,
root/device/inode/mount checks, immutable per-file identity, bounded byte hashing,
complete output inventory checks and cancellation/lease callbacks. Root-relative
lease slots are walked from an already pinned base directory, so a symlink in an
operation parent cannot redirect them. Source readers can access only the bound
source inventory. Files are verified before and after independent verification.
The helper rejects unsupported platforms rather than weaken its checks.

`createPinnedReadCustody` derives the private slot solely as
`<configured-private-root>/<operation-id>/<lease-token>`. It creates no directory
and accepts no caller filesystem path. It requires explicit maintenance/source/
destination fencing and durable registration/promotion callbacks before opening
files. **Read descriptors do not themselves fence cleanup or external writes.**
The actual cross-worker maintenance fence, capacity reservation, transport,
durable promotion/rollback reconciliation and client render-only manifest remain
uninstalled gates. Raw atlas proof must remain private rather than become a
client-rendered asset merely because it appears in the full supplement inventory.

## Lifetime and errors

The recovery service permits one in-flight preparation per operation in-process,
holds an opaque lease-bound ticket and disposes it on commit, discard, abort,
abandonment, expiry or explicit close. Worker shutdown must call close and await
the cancelled preparation; decoders must honor the signal and reap children.
No timer, background process or worker is started by these modules. The trusted
registration callback is synchronous and uses the transaction's fresh lease
guard after failure restoration, rather than the old failure-state fingerprint.
Cleanup errors are separately audited without private exception text. A committed
result remains successful with `cleanupComplete:false`, requiring owner attention;
an abort listener cannot throw a release error into the process.

## Qualification boundary

Earlier head265725 has116 unique Linux source cases passed across separate runs;
that evidence does not qualify this newer adapter source. Current Windows tests
exercise schema/hooks/state/lifetime and fail-closed platform behavior. The Linux
descriptor/custody test bodies, new source integration, producer endpoint,
new converter image and real Todd result need independent Linux/live acceptance.
No physical promotion, texture proof, installed recovery, publication or actual
coordinator ACK delivery is established by the synthetic callback fixtures.


## Recovery lifecycle holds (source successor)

Non-complete recovery operations now pin their output, dataset, task and project
against ordinary archive/trash admission. Expired leases and failed operations
retain that hold: a timeout is not proof that another process released its file
descriptors. A future explicit release path must verify custody cleanup before
removing abandoned holds; this change does not install that path.

Recovery admission rejects output lifecycle journals in intent, fs_applied or
failed states as well as the existing dataset-operation checks. Storage lifecycle
application re-reads the persisted intent and checks holds under BEGIN IMMEDIATE,
keeping that write lock through the synchronous filesystem change and fs_applied
marker. A blocked intent remains recoverable rather than being marked failed.
Existing crash reconciliation remains required when a filesystem effect precedes
a rolled-back journal transaction.

This is cooperative exclusion for the journaled storage-lifecycle path only.
It is not an OS-level write fence, old-worker capability qualification, a fence
for all derivative/cache maintenance, a promotion journal, or actual adoption.
Those independent gates remain closed. No endpoint or ordinary-worker dispatch
is enabled, and no runtime or retained model is changed by these source tests.


## Immutable lease-slot registration

The staging composition factory `createStagingImmutableSupplementQualifier`
connects the existing producer/source/independent-proof qualifier and physical
read custody to `registerImmutableSupplement`. It derives the output location
from persisted output identity and the recovery operation/lease token:
`<output>/derived/recovery/<operation>/<token>`. The trusted models root is pinned
and every component below it is walked without following symlinks. No rename,
manual database insertion, reconstruction, or published-version edit is used.

The trusted verifier's `verifiedLodAsset` result now also carries its checked
`renderArtifacts`. Its established whole-directory hash/manifest semantics are
unchanged. Registration requires the complete hashed inventory to match the
supplement, then constructs a separate render-only manifest/hash using the
existing repository hashTree ordering. Every render file must match exactly one
checked artifact, and every artifact must be render-tagged. Only this manifest
enters model_asset_files. Private JSONL, raw texture-proof rasters, diagnostics
and unlisted siblings remain inaccessible through the existing exact-file
integrity authorization even when they occupy the same directory.

Private/diagnostic byte counts have their own model-output storage component;
the full role-tagged inventory is retained in an internal recovery audit journal.
The existing finalizer accounts render bytes separately, and both participate in
the same restore/register/ready/ACK transaction. SQL failure leaves the existing
private filesystem slot intact and the original failed state unchanged.

The composition rejects production bindings. It is not installed in HTTP or the
ordinary worker yet: the actual producer-incarnation endpoint/receipt, qualified
converter and independent full-resolution proof engine, and actual write and
maintenance exclusion must be supplied before a supported staging run. Synthetic
source tests exercise real SQL registration/finalization and private-file denial;
they do not qualify geometry, texture pixels, production access or adoption of a
retained real model. The composed physical-path positive test must run on Linux;
Windows exercises only its explicit platform denial and fence release.


## Bounded staging runner and actual controller restrictions

`runDerivativeRecovery` executes one selected staging operation, not a daemon.
It claims the existing heavy-work lease, loads only through a trusted signal-aware
loader, renews lease/authorization/source checks during loading and proof work,
prepares and commits, and clears every owned timer. Cancellation awaits reader
termination before abandonment; reclaimed owners cannot abandon replacement
leases. A controlled intake phase can resume its exact private owner/token via
heartbeat, preserving the existing deadline. No token is included in receipts or
accepted through an installed HTTP route. Failure receipts contain static codes,
not private paths/errors. Failed recovery holds remain retained.

`createReadOnlyRecoveryFence` verifies actual Linux model/root mount RO flags,
model directory mount/inode identity, nonroot UID and absence of CAP_SYS_ADMIN.
It also demands a continuous synchronous server-owned exclusive-maintenance
admission. The source failed-state guard runs at acquisition; custody uses the
phase-appropriate source guard during preparation and fresh lease guard during
registration. The OS fence must not retain an obsolete failed-state assertion
across atomic restoration.

RO mounts restrict the controller and its children only. They do not fence a
writer in another namespace or an SMB client. Host admission must identify and
exclude the actual writers for the full run. The proposed controlled window
stops only admitted staging Viewer API/worker writers, preserves coordinator and
native services, mounts finished sources/slot read-only and keeps only the DB
writable. No service shutdown or actual custody admission has been performed by
these source changes. Supported controlled artifact intake remains to implement;
operator copying into a model directory is not the contract.

A compatible staging API/worker image and exact startup/rollback behavior are
required before migration43 or a real adoption. The owner reports installed399/
c981 at schema42. A DB-only one-shot migration followed by silently restarting
old writers is not qualified rollback or release. Preserve43 journal/holds,
retained source files, current sessions/permissions and the accepted converter
contract in the composed image and its rollback plan. Actual producer endpoint,
full-resolution proof engine, controlled intake and route/controller installation
remain independent gates.


## Controlled artifact intake

stageDerivativeSupplement is the staging-only application intake contract. A
server-owned caller requests and claims an eligible operation with the canonical
supplement digest. Intake requires that private owner/token, current staff/source
checks, exclusive host write admission and StorageManager capacity. It streams
exact manifest-listed files through a trusted signal-aware producer adapter in
chunks no larger than 1 MiB. No caller filesystem path or URL is a destination.

Linux descriptor-relative traversal refuses symlinks/mount changes. Existing
finals are rehashed and never overwritten. New files use exclusive temporary
creation, exact size/hash checks, fsync and exclusive hardlink activation. Depth
and directory budgets match final verification. Stable metadata serialization
allows reordered-key retries. Capacity counts remaining files and is rechecked
before new payload bytes. Original failed state/source records stay unchanged.

Canonical manifest and completion records sit beside the output slot, outside
render closure. A durable system audit binds operation, lease-token digest,
inventory digest, counts, interrupted-byte count and metadata byte count/hash.
createStagedSupplementLoader requires these and fresh authorization/source/lease,
and is the runner loader. No installed route or arbitrary upload grant exists.

Partials sit in a separate private parts/token directory. Ordinary errors remove
only temporary inodes created by that call. Process death can leave parts; retry
retains them, excludes them from render verification and separately accounts for
bounded unique interrupted data bytes. Aliases to final data/metadata are not
counted twice. Two-link metadata is accepted only with its one extra alias proven
inside this private parts directory. Unknown old files are never deleted.
Readiness/accounting includes private-proof, interrupted payload and manifest/
marker metadata components. Interrupted data has no fabricated verification hash
and never enters model_asset_files.

Linux tests use supported intake, loader, resumed runner, qualifier and real SQL
registration. Negatives cover wrong/truncated/oversized bytes, revoked access,
lost write admission, retry, missing receipt and symlink parents. Bounded child
processes exit during payload write, after manifest hardlink and after completion
hardlink; parent reaps them and tests retry/accounting. These Linux bodies remain
unqualified in current Windows checks; Windows asserts platform denial only.
Actual host custody, producer/converter proofs and compatible image deployment
remain necessary. Operational intake uses this receiver, not operator copying.

Compatibility clarification: c981 applyMigrations loops known migrations without
explicitly rejecting an extra 43 row. Schema 43 alone therefore does not prove an
old-image startup failure. Functional forward compatibility, recovery-hold and
provenance enforcement, and safe restart still need testing. Do not restart old
writers ignoring nonterminal holds or invent a database downgrade/discard records
as rollback.


## Narrow host entrypoint composition

createStagingRecoveryController captures a server-selected operator and one
attempt/job. Its methods never accept caller filesystem paths, lease tokens,
callbacks or deployment flags. Request preflight checks authoritative producer
identity, original source/frame and the qualified converter before journaling.
The controller caches only that canonical manifest for intake; retry after a
controller exit can repeat the same request/preflight. Staging uses the existing
receiver and clears its manifest cache after success. Running uses the sealed
loader and private lease, with actual RO checks BEFORE entering the runner so an
unsafe handoff does not abandon valid staged work. The qualifier holds the fence
again through proof/registration. Status is actor/target scoped and contains no
raw journal, source path or token. No route or background service is installed.

The qualified15bfea recovery primitives are unchanged by this wrapper. Its host
must supply actual server-owned producer/proof/qualified-converter and writer
admission hooks, install a compatible image and select the exact target. Writer
exclusion concerns actual application writers; controller RO and guarded stable
reads do not promise immunity from privileged NAS administration. Observed
mutation fails closed; no new NAS administration is part of this entrypoint.

Image preparation must freeze the Root-owned Viewer overlay and sanitized actual
qualified converter publication. It must not silently recompile a supposedly
identical binary, bake a private license into a layer, or claim a release from a
moving working tree. Baseline frontend compatibility is decided by the actual
server verification receipt, lodProvenanceVerified:true and renderer acceptance;
legacy browser hash sets alone are not a demonstrated blocker. UIcomposition558
is separate. Native full-resolution memory acceptance, actual producer route,
proof-engine closure, functional image/rollback and host admission remain open.
