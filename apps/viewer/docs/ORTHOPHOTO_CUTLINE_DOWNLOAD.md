# Orthophoto cutline product registration

Viewer retains and registers the known cutline product beneath
`odm_orthophoto/`: `cutline.gpkg` / `cutline.geojson`, plus explicitly named
`odm_orthophoto_cutline` and `orthophoto_cutline` equivalents. WebODM's canonical
download is `cutline.gpkg`, mapped to `odm_orthophoto/cutline.gpkg` in its
[task asset definitions](https://github.com/OpenDroneMap/WebODM/blob/master/app/models/task.py).

GeoJSON must contain polygon/multipolygon geometry and is bounded to 8 MiB for
validation. GeoPackage must have the SQLite and GeoPackage header signatures;
Viewer does not open/execute its database or rewrite its contents. General JSON,
ZIP archives, other directories and malformed known-name files are not promoted
as cutline products. A header signature is format identification, not a complete
GIS topological-validity check.

Retained imports keep cutlines with the orthophoto retention policy. Catalog
and processing-output discovery register an `orthoCutline` asset with its exact
file hash, size and source path. The download menu uses existing live model,
version and download authorization. Unpublished assets remain private except
for authorized review access. Revoked model download access invalidates tickets.
Downloaded geometry is byte-for-byte the source; no clipping, reprojection or
simplification is performed here.

## Existing imports

Installing this code does not automatically scan or mutate production assets.
Older retained imports may have omitted the cutline entirely, and existing
registrations are immutable version records. A controlled catalog/import refresh
or reimport is needed to register an existing source cutline; if retention removed
it, restore that specific product from the original backup first. Do not reimport
automatically or imply a menu item can recover missing source bytes. The existing
catalog scan/remap path retains its fingerprint/approval and version safeguards.

This product is distinct from drawing a measurement polygon, calculating surface
cut/fill, or applying a display mask to the orthophoto. Those workflows require
their own tests.
