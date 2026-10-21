# Photo, camera marker, and point-cloud navigation QA

This change is isolated from the LOD performance experiments Hermes is running.
It does not retile datasets, change model-cache policy, modify Operations, or
retry production imports. Base: `26643bec38765f1af1d447a90afd87bb89fde70d`.

## Behavior

- A camera click still opens the non-blocking upper-right photo preview. Clicking
  the preview expands it to the browser content viewport, not monitor fullscreen.
- Filename stays at the lower left and capture date/time at the lower right.
  Altitude is omitted. Portrait, landscape, and panorama images retain aspect
  ratio; fit-scale panning is locked and zoomed panning remains bounded.
- Zoom changes the image's painted layout dimensions rather than enlarging a
  permanently promoted fit-size CSS raster. The original photo URL is reused.
- Staff Viewer review/published sessions receive `cameraPhotoDownload: true`,
  allowing the existing Download Original button without enabling general model
  downloads. General `download` stays false. Public-share settings are unchanged;
  their existing download flag still controls this button. A new staff grant is
  needed for older sessions to receive the new capability.
- Camera glyphs have a light frame, orange rear panel/image-up tab, and amber
  forward octagon. OpenSfM image-up is local negative Y, not positive Y; upside-down
  photos correctly retain an upside-down tab. Model and cloud use matching unlit
  colors and tested geometry parity, not two differently lit materials.
- Default world-size remains 0.5. All valid in-view 3D camera sources are retained,
  including overlapping cameras. Screen-cell nearest-camera replacement and the
  implicit 4,000-marker cap are removed. Poses are not relocated or clustered.
- Orthophoto markers use orange camera pins anchored by their tips at the actual
  coordinates. Pixel size is independent of map zoom. Leaflet marker objects are
  reused while panning/zooming; all valid source positions are represented.
- Point-cloud dolly now updates Potree's focal radius with camera displacement.
  Previously the stale radius moved the derived pivot away from the model and
  left screen-pan using a near-view distance after zooming far out. Sparse
  overview orbit can use a bounded ray/box hit if its focal-plane point misses;
  empty-background and close no-hit orbit still do not invent a surface hit.

## What the photo investigation established

Viewer imports/retains referenced original JPEGs, verifies their size and SHA-256,
and serves their bytes without resizing or re-encoding. The photo renderer and
download link use the same exact source URL. Existing HTTP tests compare returned
bytes with retained originals. No Viewer JPEG recompression was found.

That does **not** establish that the particular Church backup contains the same
original bytes as WebODM, or that the user's production softness is fully resolved.
For that remaining comparison, use the same filename in both applications,
compare downloaded size/hash and natural pixel dimensions, then compare the same
crop at one source pixel per physical screen pixel. Do not compare two different
zoom percentages or infer original resolution from a preview's appearance.

## Automated evidence

- Original-photo byte preservation and denied-camera access: camera-photo HTTP
  tests, including Linux-only retained-file reconciliation.
- Staff photo-only capability, unchanged general downloads, and review renewal:
  review-session and provenance-receipt integration tests.
- Real Edge photo acceptance: landscape, portrait on ultrawide, and panorama on
  narrow viewport; viewport/footer geometry, native single-pixel stripe contrast,
  no Fullscreen API, no refetch on expand/zoom, and bounded pan. The sharpness
  fixture is lossless synthetic imagery; it is not a production JPEG comparison.
- Marker parity and source stability: overlapping/depth-reversed projections,
  tiny pans, 4,500 sources, and actual cloud instance transforms.
- Real Edge map-camera tests: same Leaflet marker objects/source IDs after zoom
  and pan, fixed icon dimensions, and source-coordinate pin anchoring. This
  existing fixture advertises a TIFF without serving its pixels; it tests marker
  interaction, **not** successful orthophoto streaming or imagery quality.
- Actual shipped point-cloud controller methods: fourfold zoom-out, both mouse
  pan modes, sparse overview orbit, off-center dolly, and no-hit rejection.
- Production frontend build.

Recorded focused runs: 70/70 integrated Linux tests, followed by the added
large-UTM navigation case passing on Windows and Linux; 50/50 final Windows
camera/photo/navigation/staff-session integration checks. These overlap and must
not be added together as distinct test totals.
Output-access and public-project-share regression tests also pass (2/2).

## Production or Hermes manual retest

1. Keep the LOD baseline unchanged while evaluating this separate change.
2. Open a fresh staff Viewer session; click a camera, confirm docked preview,
   expand it, and download one original. Check name and bytes against the import.
3. Resize the browser through ultrawide, portrait, and narrow layouts. Verify
   metadata corners, no altitude, and no blank-space panning beyond image bounds.
4. Inspect upright and inverted camera glyphs from both sides in model and cloud.
   Toggle markers and orbit slowly: overlapping cameras must not trade identities.
5. On the orthophoto, confirm all pin tips stay at their captured locations when
   zooming; pins overlap at overview and separate naturally at closer zooms.
6. In point cloud, repeatedly zoom out, orbit on the cloud, right-pan and middle-pan,
   then zoom back in. Compare equal-pixel drags at equal screen framing with model
   controls. Confirm empty-background clicks do not grab a remote false pivot.
7. Test a restricted public share: no new download affordance unless enabled by
   its existing share permission. Staff photo download must not expose raw model
   inputs or otherwise broaden asset access.

Rendering every camera increases dense-marker overdraw and map DOM work. The 3D
path remains instanced, but no production hardware performance claim is made for
extremely large camera sets. These tests do not substitute for that measurement.

## 2026-09-06 point-cloud navigation overhead fix

- Hidden point-cloud camera markers no longer project source positions or upload
  instance buffers on viewer updates. Showing markers forces a fresh update at
  the current viewpoint; their positions and source identities are unchanged.
- Camera-marker hover raycasts are suppressed while dragging, panning, coasting,
  touching, or inserting a measurement. Stationary mouse hover and actual camera
  clicks remain available. Point budgets, EDL shading and navigation math are unchanged.
- Regression coverage uses 8,500 cameras and 120 hidden updates, asserting zero
  camera/layout reads and zero instance-buffer uploads, followed by immediate
  repopulation when shown. Navigation-state tests cover hover suppression.
- Live pre-update inspection identified server revision `ad67868`. The cloud HUD
  reported 5 FPS with 1.5M visible points and camera markers off. This observation
  does not establish that camera overhead alone caused the reported slowdown;
  a full frame trace was unavailable. Retest orbit, pan and zoom after deployment,
  with markers off and on, before claiming the broader performance issue resolved.
