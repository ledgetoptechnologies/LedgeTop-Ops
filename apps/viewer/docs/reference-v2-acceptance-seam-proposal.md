# Non-destructive TreeDar acceptance seam (review only)

Status: proposed cross-repository test seam, unagreed and inactive. The current
Viewer v1 bridge accepts one ODM archive only. No current Viewer path consumes
this outer-v2 TreeDar result, creates its accepted-copy receipt, or issues its
acknowledgement. Preserve v1 behavior and hold uncertainty; do not create a real
client job from this proposal.

## Existing evidence

Beau's read-only check found a matching saved ODM attempt and a schema-v1
archive receipt: identity, 71-entry inventory, bounds and inventory digest
matched; `3d-tiles` was true and the mesh tileset was listed. The queried
point-cloud 3D Tiles candidate path was not listed. This is evidence about a
recorded inventory, not current disk custody, a completed orchestrator return,
TreeDar, genuine LiDAR or absence of EPT/point-cloud files elsewhere. Viewer
discovers EPT separately via `entwine_pointcloud/ept.json`.

## Proposed paired boundary

Use Processing's pinned outer-v2 proposal and the
`ltds-treedar-bundle-v1` inner contract as review inputs, not as a negotiated
fingerprint. Version and capability negotiation remain separate owner decisions.
The outer `treedar_bundle` is a physical ZIP, not a `tree_inventory` object or
a renamed DEM. The inner closure has twelve required native paths and may have
other explicitly allowed entries from the pinned vocabulary; the archive must
contain exactly its manifest and listed members. Check exact path, semantic
role, format, size and SHA-256, collisions, unknown members and bounded expanded
bytes. Independently verify the compressed ZIP's size/hash, the canonical inner
manifest hash, and each expanded member's bytes. Structural fixture bodies do not
prove COG validity, CRS, tree quality or genuine acquisition.

Bind stage and result to the original job, generation, environment, parent
claim, input-manifest and pipeline digests, stage/worker/image/reservation and
result-set identities. Require trusted acquisition and custody evidence for the
exact original LAS/LAZ object IDs, sizes and hashes, including the original
source's non-photogrammetric status and appropriate unit/datum checks. File
extensions, user metadata, claimed booleans, or an EPT derivative alone do not
establish this provenance or that the original remains protected from purges.
Original LiDAR remains retained under its independently authorized custody
policy. Raw Emlid CSV files must never be deleted, including during cleanup,
failure, cancellation or rollback; derived artifacts do not replace them.

At the Viewer/NAS boundary, an authorized ingress must reserve all simultaneous
copies and hold a real writer/stream fence; persist intent; receive and verify
the exact object and typed closure; durably commit the accepted bytes and
directories; and only then issue an authenticated accepted-copy physical
receipt. Bind the receipt to exact result, source, validation evidence and the
separately authenticated producer-custody receipt. A producer's preupload
custody assertion is not the NAS receipt; neither a fixture flag nor successful
fsync alone proves an independent issuer or physical fence.

The candidate `PartialAcceptance` binds an immutable receipt/storage ID,
original binding, result-set and result-manifest digest, explicit accepted
artifact IDs/size/hash and their producer/accepted-copy/validation receipts,
validation version and a stable ACK operation ID. Subsets must remain subsets:
derive required IDs from the approved typed closure and require exact verified
coverage before claiming all requested artifacts accepted. Check coverage for
each stage and manifest; it cannot establish full-job success or substitute
for a missing or failed stage. Do not merge unrelated manifests. The endpoint,
sender/receiver ACK body, authenticated
issuer, canonical digest rules and conflict/lookup behavior are **not agreed**;
do not invent an ACK as if it exists. A future ACK must bind the precise
acceptance and operation ID, support exact replay after lost responses, and
refuse changed payloads. Unknown delivery or receipt lookup remains held.

Publication is a separate currently authorized catalog operation. Verified
acceptance does not imply publication or permission to serve HTML with the
application's origin. Execution-slot release is distinct from result delivery:
all requested heavy stages must actually settle before any slot release. This
requires independent evidence that the worker and children stopped writing and
cannot resume under a stale fence; terminal status or lease expiry alone is not
that evidence. Storage/source/outbox holds remain until their independent rules
are satisfied.
Producer cleanup requires a separate exact acknowledged cleanup intent, current
retention and pin checks, authoritative physical identity and observed outcome;
it never deletes a Viewer managed copy or releases original LAS/LAZ custody by
implication. An unproven fence, partial write, lost ACK or uncertain cleanup
holds the corresponding bytes and reservation.

## Next review artifact and tests

Processing and Viewer should pin one jointly reviewed schema, lexical rules,
capability fingerprint and immutable public positive/negative vectors, then
build disabled fixture-only adapters for the exact result/acceptance/ACK seam.
Tests should exercise TreeDar-only and combined-stage identities, all required
members and declared optional entries, altered/missing/extra/duplicate members,
wrong source/provenance/hash/role, bounded expansion, partial acceptance,
conflicting replay IDs, crashes before/after each durable barrier, ACK loss,
current-authority revocation and independent physical budget/fence behavior.
Fixture values and mock issuers must never become production authorization.
Full semantic file validation, live issuers, retention enforcement, safe
catalog rendering and deployment are independent qualification steps.
