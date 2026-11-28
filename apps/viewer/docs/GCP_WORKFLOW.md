# Ground Control Point workflow

Ground control is part of the default-off processing platform. It is available only through an authenticated Viewer administrative session with `viewer.gcp.read` or `viewer.gcp.write`. The public-share and client-session APIs have no dataset, GCP, correspondence, or raw-image routes.

## Canonical representation

- GCP set and point IDs are Viewer-owned stable identifiers.
- Every set belongs to one dataset. Its size-limited original interchange bytes are retained in the private database for auditability. If the same file already exists in the immutable dataset manifest, its ID is associated only after both the filename and SHA-256 match; the manifest is never mutated.
- Canonical horizontal coordinates are WGS84 longitude/latitude (`EPSG:4326`, decimal degrees).
- Canonical elevations and camera altitudes are meters. Ops converts them for imperial-default or metric display without rewriting stored values.
- A correspondence belongs to one processing task and links one GCP point to one image in that task's dataset using non-negative pixel X/Y coordinates.
- Database triggers reject task, GCP, or image combinations from different datasets.
- Dataset CSV/GCP source files are finalized with the private `gcp_source`
  processing role. They are retained for administrative provenance but never
  uploaded to ODM. Each attempt instead snapshots a deterministic private ODM
  `gcp_list.txt` from its saved correspondences. Restart/replay of that same
  attempt reuses its checksum-bound snapshot; retry creates a new Attempt and
  freezes a new snapshot from the correspondences current at retry time.

## Control points and checkpoints

Every point has a role: `control` (default) or `checkpoint`. Emlid imports set `checkpoint` when the point's Code is CP, CHK, check or checkpoint; generic CSV takes an optional `role` column and GeoJSON an optional `properties.role`. Staff can change a role in the task's GCP panel (`PATCH /api/v1/gcp-points/:id` with `role`).

When an attempt is created:

- Control marks become `gcp_list.txt`. Checkpoint marks never reach ODM.
- Checkpoint marks are frozen with their surveyed position, Elevation and ellipsoidal height in the immutable `processing_attempt_gcp_checkpoints` row for the accuracy report.
- If the attempt has a `gcp_list.txt`, its options get `use-exif: false`. ODM georeferences from photo GPS and ignores the GCP file when `use-exif` is on, and the Large 3D and High-Res presets set it.

## Checkpoint accuracy

`GET /api/v1/attempts/:id/gcp-checkpoints` (`viewer.gcp.read`) returns the attempt's frozen checkpoints and, once the attempt has a DSM, the vertical check: the DSM height at each checkpoint's surveyed position (bilinear between pixel centres) minus its surveyed Elevation, with mean, RMSE and largest residual. Both sides are in the same NAVD88 frame because `gcp_list.txt` gives ODM that Elevation. Points outside the DSM or on nodata are listed but not scored. The DSM must be in a WGS84 UTM projection, as ODM writes it. Horizontal error is not measured. The task's GCP panel shows this for its latest run.

## gcp_list.txt and heights

```text
EPSG:4326
<longitude> <latitude> <elevation_m> <pixel_x> <pixel_y> <image_name> <label>
```

- x/y are the point's geographic coordinates as imported (for Emlid, its Latitude/Longitude). ODM converts them to a WGS84 UTM zone for the reconstruction.
- z is the point's Elevation in metres: NAVD88 orthometric height for a NAVD88 Emlid project, converted from US survey feet when the CS name says ftUS. It is never the ellipsoidal height.
- ODM applies no vertical datum or geoid: it passes z through unchanged, so the georeferenced DSM, point cloud and model come out in the same NAVD88 heights the Viewer shows and measures. Feeding ellipsoidal heights would put every product tens of metres off (the geoid separation, about 34 m in parts of the US), which is the miss an earlier test recorded.
- The label is the point name with whitespace replaced by `_`; ODM keeps it as the point name.

## Generic interchange v1

The API accepts at most 2 MiB and 5,000 points in either of these explicit formats:

### `generic-csv-v1`

UTF-8 RFC-style CSV with the exact header below. `description` is optional; the other columns are required. Unknown columns are rejected so a vendor export cannot be silently misinterpreted.

```csv
point_id,label,latitude,longitude,elevation_m,description
GCP-01,North target,44.500100,-88.100200,243.84,Painted nail
```

### `generic-geojson-v1`

A GeoJSON `FeatureCollection` containing only 3D `Point` features. Coordinates are `[longitude, latitude, elevation_m]`; `properties.point_id` and `properties.label` are required, and `properties.description` is optional.

## Emlid Flow CSV (`emlid-all-columns-v1`)

The Emlid Flow CSV export with all columns. Required: Name, Easting, Northing, Elevation, Latitude, Longitude, Ellipsoidal height and CS name; Code and Description are optional. All rows must share one CS name, which sets the linear unit (m or ftUS); if it doesn't, staff choose it in the preview. Elevation is stored in metres and used as the height; Ellipsoidal height is kept for checks and the accuracy report. Staff confirm the preview before the set is saved.

## Image assistance

Dataset finalization indexes JPEG dimensions, capture time, GPS longitude/latitude, and altitude when those EXIF values exist. Selecting a GCP asks Viewer for up to 200 dataset images ranked by camera-to-GCP great-circle distance. By default the panel lists photos whose camera position is within 50 ft (15.24 m) of the point; staff can change the radius (shown in feet or metres per their display units) or switch to Auto radius or Nearest images. The API keeps metres (`radiusM`) and uses the same 50 ft default when no mode is given. This is only a search suggestion: geographic proximity does not prove that a point is visible in an image. An operator must inspect an image and explicitly save its pixel correspondence.

Raw image bytes flow directly from the Viewer origin to the authenticated Ops browser. They do not pass through the Operations Worker, are sent with private no-store headers, and are never public assets.

## Administrative routes

| Route | Permission | Purpose |
| --- | --- | --- |
| `GET /api/v1/datasets/:datasetId/gcp-sets` | `viewer.gcp.read` | List dataset GCP sets |
| `POST /api/v1/datasets/:datasetId/gcp-sets/import` | `viewer.gcp.write` | Parse and import a versioned generic file |
| `GET /api/v1/gcp-sets/:id` | `viewer.gcp.read` | Read canonical points |
| `DELETE /api/v1/gcp-sets/:id` | `viewer.gcp.write` | Remove a set and its marks |
| `PATCH/DELETE /api/v1/gcp-points/:id` | `viewer.gcp.write` | Correct or remove a point |
| `GET /api/v1/datasets/:datasetId/gcp-images` | `viewer.gcp.read` | Read indexed image positions/ranking |
| `GET /api/v1/datasets/:datasetId/gcp-images/:fileId/content` | `viewer.gcp.read` | Stream one private source image |
| `GET /api/v1/attempts/:id/gcp-checkpoints` | `viewer.gcp.read` | Frozen checkpoints and their vertical residuals |
| `GET/POST /api/v1/tasks/:taskId/gcp-correspondences` | `viewer.gcp.read` / `viewer.gcp.write` | List or save task marks |
| `PATCH/DELETE /api/v1/gcp-correspondences/:id` | `viewer.gcp.write` | Correct or remove a mark |

Every mutation requires `Idempotency-Key` and uses the same session-bound replay/conflict behavior as the processing control plane.
