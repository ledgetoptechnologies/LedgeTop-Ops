# Immutable recovery companion repair

## Cause and scope

Historical mesh recovery created a new version containing only OBJ, GLB and the
new tile tree. Sessions correctly read one version, so switching the task to that
recovery made the original orthophoto, DSM, DTM, EPT and camera links disappear
from the new version. This did not delete those original assets.

New recoveries preserve the registered same-source companion products. Existing
mesh-only recoveries require an explicit **Restore missing products** action;
the release does not mutate datasets or enqueue that repair automatically.
Operations services and publication behavior are unchanged.

## Production steps for Rome

1. Pull the verified Viewer container and open Rome's task outputs.
2. On the mesh-only recovered output, choose **Restore missing products**.
   Do not delete it, re-import its ZIP, or request another mesh conversion.
3. Monitor the resulting recovery in Background Work. It makes a new version,
   copies the original registered products and the existing verified tile tree,
   then validates that copied tree and creates a new version-bound verifier
   receipt. It does not run Obj2Tiles or regenerate KTX2.
4. Once ready, review the new output: model, point cloud, orthophoto, DSM, DTM
   and camera photos should match the registered original products. Publish the
   new version explicitly if needed; existing published sessions stay unchanged.
5. A failed operation uses **Retry product restore** / **Retry recovery**, within
   the existing one-retry policy. Do not weaken provenance checks. If the original
   storage is missing, changed, deleted, or its lineage is ambiguous, stop and
   restore/inspect that source instead.

The action is only eligible when the recovered output is the current task attempt,
its successful recovery operation unambiguously names the original source, OBJ
and GLB hashes match that source, and the current tile provenance passes the
server's strict policy. No arbitrary source/version/path can be provided by a
client. Disabled derivative processing rejects the request with a clear reason.

## Ownership, integrity and storage

- Snapshot only registered asset kinds and exact linked camera photos. EPT/tiles
  use their registered full-tree manifests; unregistered neighboring files never
  enter a recovery.
- Store independent copies under the new output's managed directory, with new
  owned asset and camera-photo rows. Never splice old paths into a new version.
  This intentionally duplicates physical storage, potentially including many
  gigabytes of camera photos and the existing compressed mesh tree.
- Persist the copy plan in the durable operation payload before copying, reserve
  all those bytes alongside active derivative journals, and release that copy
  reservation only when owned output accounting takes over. Older queued
  recoveries bind their companion plan under the current operation lease first.
- Hash whole files and registered chunks during one bounded streaming copy.
  Check directory containment, no-follow descriptors, source identities and
  manifest invariance; fsync the full result once before atomic promotion.
- Keep mesh derivative admission limited to OBJ/MTL/textures/audit GLB. Companion
  bytes affect real storage accounting, not the 16-GiB mesh-input limit.
- Guard both original and recovered source outputs against lifecycle deletion
  while a repair is active or eligible for its retry. Independent ownership
  allows those guards to be released when the repair succeeds.
- Validate copied tiles with the existing exact provenance/artifact verifier,
  including the exact registered tree digest. Valid v2/v3/v4 policies remain
  unchanged; KTX2 v4 is not rewritten as a generic v2 audit.

## API and verification

Workspace outputs expose `companionRepairAction`. The explicit route is:
`POST /api/v1/processing/outputs/:id/companion-repair-attempts`, empty JSON body,
processing-write authorization and normal idempotency key required.
Operation DTOs retain `type: "lod_recovery"` and add
`companionRepair: true`; existing operation polling/retry permissions apply.

Linux regression command (Node 24; run in the repository):

```sh
node --test test/lod-recovery-companions.test.js test/lod-recovery-diagnostics.test.js test/derivative-input-snapshots.test.js test/retained-manifest.test.js test/imported-derivative-delivery.test.js test/camera-photos.test.js test/processing-platform.test.js test/processing-integrity-v16.test.js
```

The suite runs descriptor-safe materialization and the real derivative worker,
including successful compressed-v4 reuse and rejection of corrupt artifacts,
wrong chunk hashes, source changes, symlink races, wrong lineage, newer task
attempts, insufficient space, disabled processing and unauthorized API callers.
Browser and real Rome production verification remain separate release checks.
