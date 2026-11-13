# Original-face to declared LOD0 UV association

This is an independent, standalone check. It does not change or replace the
approved v4 global geometry/surface audit. It does not establish global original
face coverage, emitted B3DM UV/material correspondence, KTX equivalence, browser
quality, readiness or cleanup permission.

The exact original OBJ is used directly. In the pinned converter, decimation
copies that file unchanged into DestFiles[0]; LOD0's mapping header hashes that
copy. No additional intermediate identity protocol is required: compare the
header to the retained original archive OBJ hash. The original MTL/PNG closure
is resolved independently, with stable file identities throughout the check.

Use one index for every LOD0 tile:

```python
with SourceUvIndex(original_obj) as index:
    for manifest in lod0_manifests:
        index.verify_manifest(manifest)
result = index.receipt()  # after successful once-final context-exit check
```

CLI accepts repeated `--mapping-manifest` arguments and one `--source-obj`.
Follow the clean GDAL environment, isolation and PNG-only instructions in
`verify_atlas_proof.md`; this module reuses those source-closure utilities.

For every declared triangle, the checker queries a disk-backed SQLite Rtree
for original source-face bounds that can contain it. Every candidate is counted
before material filtering. A consistent original face must have the same
material's diffuse texture SHA, coplanar/interior barycentric positions,
consistent winding and interpolated UVs matching the declaration in source
texel units. Coincident candidates with contradictory UVs fail; equivalent
coincident mappings are permitted. Each triangle must use one consistent source
face, so independent nearest vertices cannot cross texture seams.

The supported source profile is triangulated OBJ with positive indices and
finite [0,1] UVs; quads, negative indices, wrapped UVs, unsupported directives,
normal/bump/other maps and diffuse-map options fail explicitly. Degenerate
original faces are counted and never used as a unique barycentric basis.
Degenerate declared triangles can still have their vertices/UVs associated with
a nondegenerate original face; their count is explicit and winding is undefined.

Default tolerances are1e-7 source coordinate units,1e-8 barycentric weight and
1e-4 source texel. They are local association tolerances, not geospatial accuracy
or changes to v4 policy. Receipt includes them, resource limits, source OBJ and
material/texture closure digests, and an ordered aggregate of checked mapping
manifest/file digests. It sets only `sourceUvAssociationVerified`; global
geometry, final B3DM and final KTX fields remain false.

Per-tile receipts are provisional: `retainedProofInputsFinalCheckCompleted`
remains false inside the context. Only a successful context exit checks all
retained proof inputs and sets that flag true. The CLI prints success afterward.
During iteration, only the original immutable closure and current tile are
checked; prior tile paths are not repeatedly restatted. Final failure poisons
the index. At most two proof paths per tile remain retained in memory.

Resource envelope: at most5million source faces/10million vertices/UVs/4096
materials,4096 tiles,10million declared faces,4096 spatial candidates per declared
triangle and50million total candidate checks. Tile/declared-face limits are
configurable only downward within this envelope. Both are checked before new
tile/face insertion and association work. These are explicit verifier resource
limits, not photo limits.
Any overflow holds verification; rows are never silently truncated and accepted.
The existing Todd40 source has approximately1.13million triangles, fitting the
face-count envelope; its actual candidate density, numerical behavior, disk size
and runtime remain unqualified. No real-data performance claim follows from the
small tests. SQLite uses an8MiB cache and two32768-entry vertex/UV caches rather
than loading the full mesh into Python objects. Allow adequate owned scratch
disk for the index; caller must enforce wall time and space admission. Index and
temporary ledger are removed on normal completion or failure. A failed check
poisons that index so a later receipt cannot conceal it.

Source tests cover subtriangle interpolation, wrong UV/material, out-of-face and
noncoplanar points, reversed winding, ambiguous/equivalent coincident mappings,
wrong original hash, input changes before verification and at context exit,
duplicate declared faces, unsupported input profiles and resource holds. These
small injected-header tests do not qualify Linux, actual large OBJ inputs, GDAL
integration or the C# converter output.
