# Staging recovery verifier adapter

These factories wire the independently computed1b proof into the existing
same-attempt recovery controller. Importing them installs no route, worker,
startup task or polling loop. They are not an ordinary API/worker execution path.
PR5599f runtime and PR5731b proof remain separately qualified immutable inputs.

## Owner composition

In a fresh, owner-admitted isolated staging recovery controller:

1. Use actual qualified image, engine, Node/ABI, Python/GDAL, native/Basis and
   dependency evidence to construct the fixed `runtimeBinding`. Its engine source
   commit is1b015a179c12ef6c18047910eebd7ec7e44f2b23; this does not relabel a9f image.
2. Construct `createRecoveryProofExecutor` with canonical `nodePath`, fixed
   `scriptPath` for `scripts/verify_recovery_candidate.mjs`, and a new/private0700
   `workRoot` outside every source/output root. Supply actual trusted
   `assertRuntimeQualified`, `assertResourceAdmission` and `onCleanupStall` hooks.
   Qualification/admission must return literaltrue. They are host configuration,
   never model JSON, browser fields, peer messages or new execution authorization.
3. Construct `createRecoveryCandidateVerifier` with environmentSTAGING, exact
   managed `modelsRoot`, the same fixed runtime binding, canonical converter/Basis
   paths, the executor, existing `processing` repository and a trusted
   `getQualifiedCalibration` registry/read. Pass the resulting function as
   `verifyCandidate` to the existing `createStagingRecoveryController`.
4. Call `await verifyCandidate.preflight(...)` BEFORE requesting/staging an
   operation. This metadata-only check writes nothing and avoids consuming a
   recovery operation while calibration is still pending. Existing actor, producer,
   converter, source, intake, maintenance/write and storage admission checks still
   apply. The callable verifier checks calibration again before and after proof.

Keep the750-file1b proof view byte-identical. The new adapter/updated server
provenance helper must live in a separate readonly source view, or in an explicitly
qualified new composition. Point the fixed child script into the frozen1b view;
do not overwrite its server files and still claim manifest733eb0ef. The parent
adapter source commit is separate evidence from the unchanged proof engine commit.

The runtime binding is schemaVersion1 with imageId, sourceCommit, nodeVersion,
nodeAbi, pythonVersion, gdalVersion, converterBinarySha256,
basisJavascriptSha256 and basisWasmSha256. Optional additional fields are bounded
named SHA256 pins. Constructor metadata is copied/frozen. It must represent the
actual admitted runtime; the factories cannot establish image/ABI qualification
from these strings. The host hook must verify the exact runtime and readonly
source/dependency closure, not just accept the requested image label.

The independently reviewed calibration registry record must contain:

    schemaVersion: 1
    status: qualified
    engineSourceCommit: <exact engine commit>
    runtimeBindingSha256: <SHA256 of shared stable(runtimeBinding)>
    policy: <exact frozen photographic policy object>
    basisPins: { javascript: <exact SHA256>, wasm: <exact SHA256> }
    converterBinarySha256: <current qualified3f binary>
    receiptSha256: <actual calibration evidence digest>
    independentReviewSha256: <actual independent review digest>

A pending calibration run or the child's `ready`/calibration fields cannot create
this record. Root must join actual fixed-patch/holdout/sensitivity/runtime/cleanup
evidence and independent review. Runtime/calibration evidence does not replace
fresh workload admission, actor authorization or the existing physical fence.

## Runtime and custody

The external owner provides a NEW task-owned container/cgroup, isolated PID
namespace and init/reaper, readonly source/output mounts, unprivileged identity,
no network/devices/socket/ports/secrets or unrelated execs, actual CPU/memory/PID/
scratch limits, pressure admission, hard deadline and final CID/cgroup cleanup.
Do not run the executor in a normal web API container or share its PID namespace
with user/other-agent work. Only one proof may run in each executor instance.

The verifier derives unique original OBJ/GLB from the canonical retained input,
requires actual `PinnedSupplementDirectory` custody objects and the exact
immutable operation slot, and holds OBJ/GLB read descriptors throughout the child.
No request can select a script, command, environment or replacement source.
The fixed child CLI receives only its private JSON request. Output is capped at
8MiB, stderr at4KiB; its deadline is clamped to the operation and30minutes.

The executor waits for actual direct-child close AND owned detached-group
retirement. Failure, timeout or cancellation terminates/reaps descendants even
after their leader exits. An observed-dead PGID is never probed/reused again.
If cleanup remains uncertain after escalation, the executor reports one static
owner notice and retains the promise, busy slot, private request and custody.
It does NOT reject and let the existing outer finally release its fence while a
reader may remain. The external owner must resolve/kill the whole owned cgroup;
never delete uncertain work or kill a user/shared process.

The optional `signal`/synchronous `checkpoint` on the existing server provenance
verifier now interrupts artifact hashing, destroys the current read stream and
waits for close before rejection. Default V2/V3/V4 acceptance policies are
unchanged. Lease guards must throw on loss; false/async guards fail closed here.

## Proof and registration

The factory binds the trusted executor's runtime/source/request/exit/reap record
to the actual proof. Source, raw-UV tile/face/final-check counts, frozen policy,
decoder hashes and complete root/parent/LOD0 render hashes must agree with the
canonical manifest. Stored provenance is read through pinned custody and must
equal fresh evidence, then pass the existing server V4 validator. Full verified
file accounting is retained, while only audited render files can be published.

Before returning, the existing audit repository retains SHA-only verification
evidence linking runtime, source/output, independent calibration review, raw-UV,
photographic metrics and V4 provenance/counts. Its scope explicitly does NOT mean
registration/readiness; it contains no tokens, source paths or pixels. A failed
audit write prevents acceptance. Preflight never writes this event.

Only after these checks does the function return the existing strict verified
asset and independent-receipt shape. The outer qualifier still rehashes all input
and output files. The existing transaction alone restores/registers/checks all
required derivatives/marks ready/ACKs. These factories do not perform that
transaction or alter original failure/history/source/permissions themselves.

## Qualification status

Local source checks use mocked child/filesystem/group adapters or tiny metadata
files; no actual model, converter, WASM or GDAL image decoder runs on Beau's PC.
The complete mock adapter set is mandatory so fake PIDs cannot fall through to
host process-group operations. Actual Linux FD/mount/process-group/timeout/failure
qualification, independently reviewed calibration, real retained-model proof,
supported adoption/ready/ACK and later production acceptance remain required.
