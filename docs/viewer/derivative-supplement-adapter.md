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
