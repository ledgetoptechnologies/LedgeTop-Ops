# County Road D numerical reference

Evidence supplied by Hermes on 2026-09-22 is represented by
`test/fixtures/county-road-d-webodm-reference.json`. The fixture retains the exact
12-vertex polygon, source identity/hash, request/response evidence hashes and
WebODM's measured scalar. It is not a surveyed ground-truth fixture.

## Independently checked source

The local `dsm.tif` supplied in the evidence directory is 556,007,817 bytes and
was independently SHA-256 checked:
`0265277ff9c34805e2de4aff20cf568bf36d5a205423f6b0c39631880be7f514`.
The DSM crop for the exact polygon is 4017 by 5533 cells (22,226,061 cells), at
approximately 0.01014024493029 metres per cell. No downsampling is needed.

## Initial comparison, before base triangulation correction

Both map and spatial3d requests, now sampling the same DSM boundary elevations,
returned exactly the same values:

| Calculation | Net m³ | Cut m³ | Fill m³ |
| --- | ---: | ---: | ---: |
| Viewer ear-clipped base / fractional cells | 5516.122456077921 | 5517.981550396219 | 1.859094318298464 |
| Independent WebODM-compatible replay | 5647.053357242632 | 5647.636694525925 | 0.583337283291220 |
| Delaunay with unsnapped world boundary coordinates | 5647.300317374687 | 5647.891212438461 | 0.590895063773786 |

The initial Viewer difference was **-130.930943922079 m³ (-2.318571%)**.
It must not be reported as matching WebODM. The dominant discrepancy is the
reference surface triangulation, not the missing vertical-unit tag. The
world-coordinate Delaunay diagnostic differs from WebODM by only 0.246917 m³.

The independent replay returns **5647.0534 m³ after four-decimal rounding**, exactly
matching Hermes's live WebODM response. Its source formula was checked against
[WebODM's version-pinned volume source](https://github.com/WebODM/WebODM/blob/3aaa247e1e76685bf6066b12a98c9e6e39384583/coreplugins/measure/volume.py).
The original WebODM environment's GDAL/SciPy versions are not pinned; this replay
used rasterio 1.5.1, scipy 1.18.1, numpy 2.5.3 and pyproj 3.8.0.

## Corrected Viewer validation

After adopting a Delaunay boundary base, independently rerunning both map and
spatial3d requests returned exactly equal results on the source DSM:

- Net: **5647.2716911718235 m³**.
- Cut: 5647.862660238431 m³; fill: 0.5909690666079715 m³.
- Difference from WebODM's published scalar: **+0.218291171824 m³ (+0.00386558%)**.
- Explicit numerical comparison tolerance: **1 m³** (approximately 0.018%). Passed.
- Native window: 22,226,061 cells; 20,969,439 valid samples. No resolution reduction.
- Coverage: 0.9999999998522632 (floating-point residual at full coverage).
- Source height-unit basis: reviewed-source-provenance; no requester override.

This small residual is intentional: Viewer preserves world-coordinate boundary
vertices and fractional-cell integration rather than WebODM's integer pixel
snapping and all-touched full-cell integration. The tolerance only tests numerical
compatibility on this reference case; it is **not** a field-accuracy guarantee.

A 40.7313215551-metre transverse profile through the same polygon was calculated
from the completed result's frozen reference patches and exact same DSM/hash.
It visited 4017 native cells, returned 4021 segments (3967 valid sample segments),
and reported only sample/outside-selection statuses. Surface/base values were
finite. Frozen base SHA-256:
`58616319098f813d62624b2de80071aba4f98c69349b6c8f5c3bd9fd888b8011`.
No reconstructed/fitted replacement base was used by the profile.

Independent geometry checks additionally cover a concave notch with a sloping
base and offset, verifying the frozen side profile does not bridge outside the
selection, and rejection of references exceeding the 254-patch profile bound.

## Repeatable verification

### Production worker verification

The original DSM was also tested through `childCalculation` inside the production
runtime container, with read-only input mounts and networking disabled. The worker
returned 5647.2716911718235 m³ in 9.259 seconds, within the explicit 1 m³ comparison
tolerance. This exercises the actual child process, not only the calculation engine.

This check exposed an IPC lifetime bug: the child could exit successfully during
asynchronous work before delivering its result. The child now keeps its channel
referenced and awaits the final send callback; the parent allows buffered messages
to drain before reporting interruption. A real multi-megabyte transport regression
and 56 other runtime measurement, permission, geometry, unit and capacity checks
passed (57 total, zero skipped). The image release gate includes the transport test.

Run the current Viewer implementation, read-only, against the exact DSM:

```text
node scripts/validate-county-stockpile-reference.mjs <dsm.tif>
node scripts/validate-county-stockpile-reference.mjs <dsm.tif> <tolerance-m3> spatial3d
```

No tolerance is invented: without a supplied tolerance the script reports the
difference but does not claim agreement. With a supplied tolerance, disagreement
returns exit code 1. The script deliberately does not supply a height-unit
override: it exercises the server-owned source-provenance policy.

The optional `scripts/compare-webodm-stockpile.py <dsm.tif>` performs an independent
read-only SciPy/Rasterio diagnostic. Install its dependencies separately from the
production application. Set `GDAL_PAM_ENABLED=NO` to prevent auxiliary metadata
writes. It verifies the source hash, masks with all_touched=True, uses linear
Delaunay interpolation and sums native cells in row strips. This diagnostic does
not submit a server job or change any saved user measurement.

WebODM's public scalar is abs(round(net, 4)); gross cut and fill can cancel before
the absolute value is taken. Compare like quantities. Neither four decimals,
agreement with WebODM, nor the report's relative LE90 proves field volume accuracy.
The selected outline, cover/tires, source reconstruction and inferred ground all
remain relevant. Client labels must not imply these figures represent a surveyed
solid material volume.
