# TreeDar Viewer artifact contract proposal

**Status: draft for owner and implementation review.** This proposal does not enable TreeDar transfers, client access, rendering, or source cleanup. The current accepted-copy API remains ODM-only.

## Goals and safety boundaries

- Preserve a complete, immutable accepted-copy record for every TreeDar result object, with the same object IDs, byte sizes, and SHA-256 digests used by the Processing result manifest and signed Viewer receipt.
- Keep producer paths and storage paths private. Transfer and retrieval address objects by validated object ID; the Viewer chooses its own storage path.
- Treat acceptance, project association, client visibility, and rendering as separate decisions. Copying an object into Viewer storage does not publish it to a client or make it a 3D layer.
- Keep the original LAS source under the existing raw-input retention policy. TreeDar output acceptance must never imply permission to delete that source.
- Reject unknown engines, roles, formats, or object closure. Do not reinterpret TreeDar semantics as an ODM `dem`, `orthophoto`, or `pointcloud` role just to pass validation.

## Candidate role registry

Keep the TreeDar producer role names in the manifest. The source filename is provenance only; it is not a client-facing path or storage key.

| TreeDar role | Current producer output | Data kind | Initial Viewer treatment | Possible future layer |
| --- | --- | --- | --- | --- |
| `ground_model` | `dtm.tif` | georeferenced elevation raster | private indexed attachment | terrain surface, after CRS, vertical units, nodata, bounds, and raster limits are validated |
| `canopy_height` | `chm.tif` | georeferenced canopy-height raster | private indexed attachment | styled height surface/raster layer |
| `canopy_height_unfiltered` | `chm_raw.tif` | georeferenced canopy-height raster | private indexed attachment | optional comparison layer |
| `crown_labels` | `crowns.tif` | categorical raster | private indexed attachment | styled categorical raster |
| `area_labels` | `areas.tif` | categorical raster, when emitted | private indexed attachment | styled categorical raster |
| `orthophoto_point_colour` | `ortho_rgb.tif` | color raster derived from points | private indexed attachment | imagery layer only after its color/CRS semantics are validated |
| `crowns` | `tree_map.geojson` | GeoJSON crown features | private indexed attachment | selectable vector overlay after feature/property limits and CRS are validated |
| `tree_table` | `trees.csv` | per-tree table | private indexed attachment | searchable table; no 3D layer |
| `tree_features` | `tree_features.csv` | per-tree feature table | private indexed attachment | searchable table; no 3D layer |
| `tree_areas` | `tree_areas.csv` | area table, when emitted | private indexed attachment | searchable table; no 3D layer |
| `lasting_tree_ids` | `tree_ids.csv` | stable tree identifiers, when emitted | private indexed attachment | join/index metadata only |
| `area_types_template` | `area_types.csv` | editable template, when emitted | private indexed attachment | downloadable template only |
| `labels` | `labels.csv` | label data, when emitted | private indexed attachment | searchable table after schema review |
| `tree_type_predictions` | `classify/predictions.csv` | classifier output, when emitted | private indexed attachment | searchable table; clearly marked as predictions |
| `quality_report` | `qc.json` | QA metadata, when emitted | staff-only attachment | none by default |
| `run_summary` | `summary.json` | run metadata | staff-only attachment | concise approved summary only |
| `classifier_report` | `classify/classify_report.json` | model QA metadata, when emitted | staff-only attachment | none by default |
| `report` | `report.html` | report document | staff-only attachment pending content review | approved report download; sanitize before browser rendering |
| `preview` | `tree_map.png` | raster preview | private indexed attachment | thumbnail/preview only |
| `area_map_preview` | `areas.png` | raster preview, when emitted | private indexed attachment | thumbnail/preview only |
| `engine_manifest` | `manifest.json` | engine provenance | internal-only, never client-linked | none |

The Producer role registry is authoritative for which optional outputs exist. A Viewer v2 registry must explicitly allow each role and define format, maximum size, and whether the role is a layer, table, attachment, or internal metadata. The list above is a proposal, not yet a protocol change.

## Manifest and storage shape

Use a versioned TreeDar result-manifest contract rather than relaxing the existing ODM endpoint. Each object descriptor should bind:

```json
{
  "id": "treedar-…",
  "role": "ground_model",
  "format": "geotiff",
  "byteSize": 123,
  "sha256": "…",
  "metadata": {
    "mediaType": "image/tiff",
    "crs": "…",
    "verticalUnits": "metre"
  }
}
```

Only role-specific metadata belongs in this descriptor. No absolute path, `relativePath`, host path, or arbitrary display URL may come from the worker. The Viewer derives a safe label and its internal object path from the validated role and object identity. Metadata must be canonicalized into the signed result manifest and receipt binding; objects remain separate byte streams uploaded by object ID.

The acceptance closure includes every declared object, including internal provenance objects. A signed receipt for only the client-visible subset is insufficient to authorize result-cache cleanup. Conversely, a full accepted copy does not make every object client-visible.

## Association and visibility policy

1. Store accepted TreeDar objects under the Viewer’s private managed root and index them by job, generation, project association (if one exists), role, size, digest, and validated spatial metadata.
2. Do not automatically associate or publish accepted objects to a project. Project association is explicit metadata and does not itself grant client or public access.
3. Default every new role to staff-only. A separate publication action may expose an approved subset to the authenticated client project workspace.
4. Keep `engine_manifest`, QA reports, classifier reports, and run internals staff-only unless a reviewed client deliverable policy explicitly changes that rule.
5. Public-link exposure requires its own role allowlist and review. It must not be inferred from the authenticated project grant.
6. Until renderers are implemented and validated, raster/vector roles remain downloadable attachments or staff-only files; do not draw them in the 3D scene or report them as renderable layers.

## Renderer admission

TreeDar v1 has no implicit renderability. A later renderer may promote roles only after tests establish supported CRS and axis order, vertical units/datum, nodata handling, raster dimensions and memory bounds, feature/property caps, styling, client authorization, and behavior for missing/invalid metadata. Do not map `ground_model` to ODM `dem` or `orthophoto_point_colour` to ODM `orthophoto` without a reviewed semantic and loader contract.

## Decisions required before implementation

- Confirm the role registry and optional-output policy with the TreeDar owner.
- Confirm which private attachments may be published to an authenticated client, and whether `report.html`, CSV tables, previews, and run metadata need distinct controls.
- Decide whether `ground_model` and canopy rasters should be interactive layers, and what vertical datum/units policy applies.
- Define a versioned Viewer/Processing v2 manifest and cross-language fixture for TreeDar; maintain the current ODM v1 behavior unchanged.
- Verify worker/source custody and cleanup against the exact full object closure while retaining the original LAS input under its separate retention rule.

## Separate workspace hierarchy decision

The Viewer workspace redesign still needs an owner decision on whether the client navigation is **customer → project → optional subcategory → task** or a different hierarchy, including whether subcategories are first-class records or labels. The current chat has no verified Claude review, decision, or reviewable design artifact for that hierarchy.
