# Elevation profile / cross-section interaction

Status: the volume inspector implements a **reduced-sample corridor preview**
with linked plan/chart inspection. A native-raster surface-transect implementation
is **implemented and fixture-tested on September 7; live deployment/County Road D acceptance remain pending**. The
broader standalone line-profile and true point-cloud section designs below are
not completed features.
The user's September 6 example clarifies that “cut line” means a sampled height
profile across a pile, not the orthophoto footprint download or volume base plane.

## Relevant references

- [Pix4D elevation profiles](https://www.pix4d.com/blog/elevation-profile): a DSM-backed line in map/3D view opens a bottom chart, with linked chart/map hover and CSV export.
- [DroneDeploy elevation tools](https://help.dronedeploy.com/hc/en-us/articles/1500004964002-Elevation): line measurements expose elevation profiles and slope information; distinguish DSM from terrain-only DTM.
- [Site Scan 2024 release recap](https://www.esri.com/arcgis-blog/products/site-scan/imagery/site-scan-in-review-2024): documents elevation-profile measurements in the mesh view.
- [ArcGIS elevation-profile interaction](https://doc.arcgis.com/en/arcgis-online/get-started/scene-elevation-profile.htm): editable multi-segment lines and separately identified elevation sources. This is an interaction reference, not a dependency or a claim about Site Scan's exact current implementation.

## Proposed Viewer behavior

### Implemented volume-inspector subset (September 6 follow-up)

Finishing a polygon first saves its geometry, then opens the measurement inspector
and requests an authorized native-raster calculation on the Viewer server. Since
the September 7 server-calculation release, this also applies to scoped client
and temporary public measurements; it does not grant import, reprocessing, or
general administrative processing permission. Missing source or unverified
vertical units remain explicit errors; unit confirmation is never automatically
checked. The normal inspector and staff-only specialist options share one
measurement entry point, while their calculation permissions remain distinct.

The inspector filters the calculation's retained preview samples into an explicit
direction/position/width corridor. The initial position uses an observed sample
row; subsequent empty corridors remain empty. Hover and keyboard inspection show
station, top elevation, reference elevation, difference, and source coordinates,
linked to a plan-view marker. Samples are drawn as discrete points: no invented
curve through unsampled cells or NoData. Full native-cell integration remains the
volume result; the preview is neither its numerical input nor a continuous
terrain profile. The native surface-transect implementation below replaces this
chart for scoped server results, with native profile CSV/PNG export. True cloud
corridors and standalone multi-segment profiles remain separate work.

### Native surface transect: implemented, real-data acceptance pending

The implementation uses the existing scoped Viewer server calculation lane.
See [verification and acceptance](NATIVE_ELEVATION_PROFILE_QA_2026-09-07.md).
Local fixture verification does not imply that the user's server already runs it.

- For a selected polygon, request a section through its immutable registered
  DSM/DTM using the inspector's direction and position. Sample the native raster
  along that section rather than extracting a curve from the reduced volume
  preview. Report the actual sampling method, spacing and coverage; native source
  resolution does not imply that every pixel is shown in an unlimited chart.
- Return station, source coordinates and elevation, with reference-base height
  and difference where the section uses the volume calculation's same base.
  Preserve gaps for NoData and points outside the selected region. Do not join
  disconnected valid stretches across unknown ground or invent a pile surface.
- Keep full-polygon volume integration separate from a section's visual profile.
  The section is an inspection aid, not a substitute volume algorithm. A DSM
  profile is a raster surface, not the complete set of cloud points in a corridor.
- Use existing measurement/model-version authorization, private ownership and
  temporary public scope. A client can request an allowed calculation on a shared
  model without obtaining import, reprocessing or general job permissions.
- Bound sampling and server work; support cancellation and fence responses by
  the current measurement revision, source version and section parameters so a
  late result cannot overwrite a newer selection. Linked chart hover should use
  returned samples, not trigger expensive model/cloud picking or another job.
- Retain source and vertical-unit validation. Unknown elevations must produce an
  understandable unavailable state, not a silent metre assumption or browser
  fallback. Verified native fixtures can establish algorithm behavior while the
  County Road D source investigation proceeds independently.

Known-unit fixtures verify native ramps/piles, boundary clipping and disconnected
spans, NoData, supported unit conversion, bounded/cancelled work, private/public
authorization, stale-response handling and the shipped inspector's linked chart.
Live County Road D numerical acceptance additionally needs verified units; it is
not implied by synthetic tests.

### County Road D source-unit dependency

The current DSM calculation rejects absent recognized vertical-unit metadata.
The user does not know its elevation units. No metre confirmation has been
inferred from horizontal EPSG, display feet, provider name or ODM software tags,
and no source-unit metadata has been changed for this investigation.

The server-access agent can follow
[the read-only County Road D checklist](COUNTY_ROAD_D_VERTICAL_UNITS_HANDOFF.md)
to bind actual source evidence to the exact immutable DSM hash. This is a
dataset-specific verification dependency, not a reason to stop independent
profile implementation, UI work or known-unit fixture testing.

### Remaining full-profile design

1. Add **Elevation profile** alongside Distance and Polygon. Click successive
   points across the pile, with the same live preview, Shift-to-navigate,
   Backspace undo, vertex editing and Finish behavior as other measurements.
2. Open a resizable bottom dock, retaining most of the map/model. The horizontal
   axis is cumulative horizontal distance along the selected line; vertical axis
   is elevation. Default feet; metric available. Always label the datum if known,
   or say “source elevation; vertical datum unverified.”
3. Hover or keyboard-step along the chart to show a linked marker on the line,
   station/distance, elevation, coordinate and local slope. Show gaps for NoData;
   never bridge them with invented surface heights. Display sample spacing.
4. Permit a DSM/DTM comparison when both are actually available and aligned.
   Default DSM for the visible pile surface. A generic DTM can remove a stockpile
   as a non-ground object: do not silently use it as the pile top or assume it
   is an observed concrete-pad base.
5. Label and save the profile privately per signed-in person and exact model
   version, as with current measurements. Public links keep it in memory only.
   Export CSV sample data and a PNG/PDF view with units, source and spacing.
6. For a selected volume polygon, optionally draw a section through that region
   and overlay the **same** reference surface used by the volume calculation.
   Shade above/below base, without implying that the area of one section is the
   complete pile volume. The full polygon integration remains authoritative.

## Data and performance requirements

- An orthophoto is an image, not a height source. Its profile must explicitly use
  a registered DSM/DTM; otherwise the feature is unavailable.
- Initial implementation should sample immutable native-resolution raster data
  with correct units, bounded reads and cancellation. Limit interactive chart
  samples, disclose spacing and use a defined downsampling policy that retains
  local extrema. Do not present interpolated display points as extra accuracy.
- Keep the chosen source stable between the 3D model and point-cloud views so
  the same saved profile does not change because different visible LOD loaded.
- A true point-cloud section like the example is a separate mode: extract points
  inside a narrow corridor of explicit width, project them to station/elevation,
  and label density/coverage. A cloud can have several heights at one station;
  do not collapse those to a single curve without naming the selection method.
- Do not perform a full-cloud GPU pick/readback for every chart hover. Hover uses
  already sampled data and updates one marker. No new client processing authority.
- Mesh sampling requires its own declared source resolution/coverage; missing
  mesh detail must not silently become a precise-looking continuous surface.

## Acceptance checks before implementation is called complete

Known flat plane, ramp, ridge and two-pile fixtures; exact endpoints and stations;
multi-segment distance; NoData breaks; metre/foot/survey-foot conversion; source
version/identity isolation; cancel during reads; no stale cross-view result;
linked pointer/keyboard hover; exports matching sample values; resizable desktop
and narrow-screen dock; frame responsiveness with a populated point cloud.

The supplied screenshot is sufficient to design this interaction. More examples
would be useful specifically for the desired cloud corridor width and whether
the user prefers all sampled points, a top-surface curve, or both.
