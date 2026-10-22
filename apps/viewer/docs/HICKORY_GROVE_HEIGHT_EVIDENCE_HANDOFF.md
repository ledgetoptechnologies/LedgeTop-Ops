# Hickory Grove: remaining display-height verification

## Scope

Read-only evidence collection. Do not restart processing, recalculate volumes,
edit saved measurements, declare units, or change Operations code.

Project: Hickory Grove Dairy LLC. Observed Viewer task title:
`Devils-River-State-Trail-9-17-2026-backup`.
Workspace task ID: `e8c7024f-6730-46ca-bc63-de9bda4f2210`.
Resolve the actual model, immutable model version and asset IDs from the server;
the workspace task ID is not a substitute for those identifiers.

## Confirmed symptoms

- Used Feed Pile: saved map outline, 7,945.088 ft² horizontal area; no saved volume.
- Larger Feed Pile: saved map outline, 36,268.307 ft² horizontal area; saved net
  volume 174,886.944 ft³ from an administrator-declared point-surface calculation.
- Both appear in the 3D measurement list but lack rendered outlines. Their cards
  report that the raster does not encode elevation units.
- The point calculation's unit declaration is not evidence for the DSM's units.
  Relative vertical accuracy in a processing report is also not itself a unit
  declaration or independent field-accuracy verification.

## Evidence requested

1. Model/version and original DSM asset identity, path within approved storage,
   byte size, SHA-256, dimensions, coordinate system, band units, GeoTIFF keys,
   scale/offset, and NoData. Prefer metadata output, not a full raster copy.
2. Matching original processing report and processing engine/version/options,
   with provenance linking them to this exact DSM and import/processing attempt.
3. Any original processing metadata explicitly identifying elevation units.
   Preserve absent/unknown values as such; do not infer metres from projected
   horizontal units alone.
4. For Larger Feed Pile, its attached calculation ID and whether the server-held
   result includes `boundaryVertices` and `source.boundaryElevationBasis`. Include
   immutable source identity and revision binding, excluding authorization tokens.

Exclude credentials, session tokens and unnecessary customer information.

## Shipped source changes and remaining limitation

Viewer main `6161d11` includes the preceding `8ea6bb5` measurement fixes:
new sampled point-volume results retain native boundary heights; display can
retrieve a correctly bound original calculation through the authorized transport
without changing saved geometry/results or starting a new volume calculation.
Saved cross-section staff routing is corrected. Ordinary permissions are unchanged.

Legacy results without retained boundary heights are not repaired by this change.
Uncalculated DSM outlines still require verified elevation evidence. The fallback
must not use Z=0, guess units, or silently recalculate a saved volume.

Release run 36281370710 passed repository checks, exact-image verification and
promotion. Its attestation identifies commit `6161d1147af34f2081fc5ed606e0eac5aa2283fe`
and image digest `sha256:b5ba0e9795feaf4b89f291d0c9152c14fc52b88988f19958ab93f4975e38d4c0`.
Deployment is not yet confirmed. After the operator update, verify the served revision before
testing either outline. Preserve the original area and volume values throughout.
