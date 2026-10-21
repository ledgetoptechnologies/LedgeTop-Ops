# Native output unit evidence: ingestion integration gap

Status: the conservative ODM resolver and persistence boundary are implemented;
**scheduled native DSM/DTM inference is now wired into ingestion**. Existing imports,
ODX producers, unknown ODM versions, and historical attempts remain unknown or
use source-bound staff review. This is not completion of the wider ODX/import goal.

## Available persistence contract

`MeasurementSourceUnitEvidence.recordVerifiedOdm(request, producerInput)` in
`server/measurementSourceUnitEvidence.js` invokes the actual resolver internally.
It accepts only native DSM/DTM bindings with no derived manifest. `request` contains
`modelId`, `modelVersionId`, `coordinateReference.crs`, and
`source: {id, kind, sha256, byteSize}`. The exact asset must already exist in
`model_assets`, joined to the requested model/version. Kind, digest, size, and CRS
must agree with resolved evidence. An arbitrary `{status: 'resolved'}` is not proof.

On success it stores basis `verified-odm-source`, metres, unknown datum, a fixed
system actor, and allowlisted producer contract/hash fields. Conflict insertion
does nothing: it cannot replace a staff review or an earlier bound record. Unknown
or inconsistent proof returns null. Database failures are not disguised as success.
The input remains an internal trusted-caller interface, never a public request body.

## Gaps identified before this integration (historical records remain insufficient)

- `processingRepository.captureNewAttemptProvenance` and
  `processingProvenance.submissionProvenance` retain a dataset manifest digest,
  options/schema snapshots, and an optional generated GCP digest. They do not retain
  the exact ordered inventory uploaded after role filtering and GCP substitution.
- `processingWorker.processSubmit` verifies source files, filters roles, reorders
  image/auxiliary uploads, and may append generated `gcp_list.txt`. It can also
  remove/reinitialize a known task during retry. Phase/count records alone do not
  establish a durable fresh-create operation receipt.
- `processingRepository.recordAttemptProviderResult` provides immutable completed
  task UUID/status evidence. This is useful but does not attest an archive digest
  or the actual executed worker/options.
- `processingWorker.processIngest` passes `downloadAll` into `extractZipStream`
  without computing/storing the complete archive-response digest. It skips download
  whenever the destination exists. A filesystem directory is not a download receipt.
- `processIngest` hashes selected assets and mesh closure, not a complete immutable
  archive inventory. `storage.scanAbsolute` counts files/bytes without content hashes.
- `readOdmTaskMetadata` model-level georeferencing is not independent per-raster
  vertical-unit inspection. A UTM horizontal CRS must not silently imply Z metres.

## Integration requirements and implementation

Migration 37, the transfer-provenance repository methods, `processSubmit`,
`processingArchiveEvidence.js`, `processingRasterUnitInspection.mjs`, and
`processingUnitEvidence.js` now implement the capture chain below. Existing
destinations without a receipt remain unverified: no digest is fabricated from
their current contents. Fresh downloads are fully spooled, CRC-validated and
inventoried with a combined compressed-plus-expanded storage budget. Receipt
verification precedes reuse; source metadata and bound artifact bytes are checked
again before lease-guarded registration. Five real-repository/local-HTTP ZIP
ingestion tests now pass, including native TIFFs and negative receipt/feet/version
cases. Deployed compatibility remains unverified. ODX, imports, EPT and other pipeline
variants remain outside this first contract, not outside the overall goal.

1. At the final upload mapping in `processSubmit`, retain a canonical ordered
   `{relativePath, byteSize, sha256}` inventory of **all** submitted files, including
   ancillary/generated inputs, and its JSON SHA-256. Bind it immutably to attempt
   and provider task identity. If the canonical inventory differs from the dataset
   manifest, retain both distinct digests; never relabel the dataset digest as the
   upload digest. Freeze processing roles used to choose the files.
2. Record successful fresh initialization and submission generation server-side,
   distinguishing a newly allocated task from resumed/restarted/reused processing.
   Task identity and generation must remain consistent through completion and
   output retrieval. Do not infer `operation: create` from missing log flags.
3. During `processIngest`, hash the **entire** downloaded response and establish a
   safe, complete per-file hash inventory from that same extraction. Complete
   response consumption, extraction validation, inventory, and receipt need an
   atomic publication/receipt strategy. Duplicate case-folded paths, links, special
   files, ambiguous roots, and replacement races must be rejected. Evaluate
   `safeZip.extractZipStream` for these requirements before relying on it as proof.
4. Persist the archive receipt and inventory under attempt/output identity before
   treating an existing destination as reusable. Retry must verify the stored
   inventory against the destination and retain the original archive digest; a
   missing receipt must remain unknown or trigger a new verified retrieval, not a
   synthetic receipt built from current files. Do not place trusted receipts where
   provider archives can supply or overwrite them.
5. Read bounded `log.json` (or `assets/log.json`), `images.json`, and
   `odm_georeferencing/coords.txt` from the verified archive inventory. Missing
   artifacts stay unknown. Inspect each native DSM/DTM GeoTIFF for actual horizontal
   CRS and explicit vertical-unit keys/metadata. Preserve conflicts, feet, unknown
   unit codes, and unsupported scaling; do not normalize them to absent metadata.
6. After `repository.upsertModelVersion` and successful
   `setAttemptResultForJob`/output registration, obtain the registered asset IDs
   and call `recordVerifiedOdm` with the immutable receipt, complete inventories,
   verified artifact bytes, and independently inspected raster source. Keep the
   lease/cancellation boundary authoritative and record evidence transactionally
   with the receipt/model association where feasible.

The worker now invokes this chain only when durable receipts qualify. Cluster
`/info` engine/version remains reference
worker metadata, not positive actual-producer proof.

## Acceptance tests for the next integration

- Fresh scheduled audited ODM DSM and DTM populate evidence bound to registered
  output IDs, not merely to the task or a filename.
- Missing historical receipt, changed uploaded role/inventory, generated GCP,
  custom geo/alignment, restart/resume with reused outputs, incomplete archive,
  absent artifacts, ODX and unknown versions never auto-resolve.
- Interrupted download/extraction and crash between promotion and receipt commit
  cannot make an existing directory authoritative on retry.
- Changed source bytes with identical size/mtime, changed companion artifacts,
  mismatching task identity, duplicate paths and explicit feet/conflicts fail closed.
- Idempotent retries preserve original evidence; staff review is never overwritten.
- Native LAZ evidence cannot directly authorize EPT/OBJ. Derived assets need their
  own verified immutable transformation chain. Imported archives need a separately
  audited import policy; they do not acquire a fresh-node receipt by folder shape.

Focused persistence/resolver verification: 16 tests passing in
`measurement-verified-odm-evidence.test.js`, `measurement-source-unit-evidence.test.js`,
and `odm-source-unit-provenance.test.js`. These are local fixture results, not live
producer compatibility or deployed validation.
