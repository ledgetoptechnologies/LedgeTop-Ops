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

## Emlid Flow adapter

The versioned `emlid-all-columns-v1` adapter recognizes the exact Emlid Flow all-columns schema, requires one consistent `CS name`, and uses `Name`, `Easting`, `Northing`, and `Elevation` as the survey values. `Latitude`, `Longitude`, and `Ellipsoidal height` are retained as geographic/vertical cross-checks. Explicit `(m)` or `(ftUS)` declarations in `CS name` determine unit conversion; otherwise the administrative preview requires an explicit unit declaration. Unknown or malformed CSVs are ignored by automatic discovery. The original CSV bytes are retained and linked to the GCP set; no file is rewritten.

When an administrator opens a task's GCP page, Viewer scans up to 20 attached CSV manifest files (bounded to 2 MiB per file and 20 MiB aggregate per request). It imports recognized generic GCP CSV or Emlid Flow CSV sources automatically and idempotently. Unrecognized, checksum-mismatched, malformed, or ambiguous files are ignored and remain untouched in raw data. The scan can be repeated when the raw dataset changes.

## Image assistance

Dataset finalization indexes JPEG dimensions, capture time, GPS longitude/latitude, and altitude when those EXIF values exist. Selecting a GCP asks Viewer for up to 200 dataset images ranked by camera-to-GCP great-circle distance. The fixed-radius picker defaults to 50 feet (15.24 m), plots the GCP and matching camera GPS positions on a large map, and opens an image when its camera marker is selected. This is only a search suggestion: geographic proximity does not prove that a point is visible in an image. An operator must inspect an image and explicitly save its pixel correspondence.

Raw image bytes flow directly from the Viewer origin to the authenticated Ops browser. They do not pass through the Operations Worker, are sent with private no-store headers, and are never public assets.

## Administrative routes

| Route | Permission | Purpose |
| --- | --- | --- |
| `GET /api/v1/datasets/:datasetId/gcp-sets` | `viewer.gcp.read` | List dataset GCP sets |
| `POST /api/v1/datasets/:datasetId/gcp-sets/auto-import` | `viewer.gcp.write` | Idempotently discover and import recognized raw CSV sources |
| `POST /api/v1/datasets/:datasetId/gcp-sets/import` | `viewer.gcp.write` | Parse and import a versioned generic file |
| `GET /api/v1/gcp-sets/:id` | `viewer.gcp.read` | Read canonical points |
| `DELETE /api/v1/gcp-sets/:id` | `viewer.gcp.write` | Remove a set and its marks |
| `PATCH/DELETE /api/v1/gcp-points/:id` | `viewer.gcp.write` | Correct or remove a point |
| `GET /api/v1/datasets/:datasetId/gcp-images` | `viewer.gcp.read` | Read indexed image positions/ranking |
| `GET /api/v1/datasets/:datasetId/gcp-images/:fileId/content` | `viewer.gcp.read` | Stream one private source image |
| `GET/POST /api/v1/tasks/:taskId/gcp-correspondences` | `viewer.gcp.read` / `viewer.gcp.write` | List or save task marks |
| `PATCH/DELETE /api/v1/gcp-correspondences/:id` | `viewer.gcp.write` | Correct or remove a mark |

Every mutation requires `Idempotency-Key` and uses the same session-bound replay/conflict behavior as the processing control plane.
