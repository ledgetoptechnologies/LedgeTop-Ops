# Native elevation-source preflight

Surface cut/fill now checks the selected immutable GeoTIFF's headers before a
staff job is queued. Failed preflight returns HTTP 422 with a specific reason;
it does not create a failed/background job. The normal personal-model and
separate same-person Operations processing permissions remain mandatory.
Authorization and measurement revision are rechecked after header I/O.

## Source units and provenance

Vertical units come from the retained source GeoTIFF's `VerticalUnitsGeoKey`:
9001 = metres, 9002 = international feet, 9003 = US survey feet. Foot elevations
are converted to metres in Float64 before integration, recognizing NoData first.
Preview and boundary elevations use the identical factor. Result provenance
distinguishes encoded raster metadata from an administrator declaration.

A horizontal UTM/metre CRS does **not** establish vertical units. If the source
lacks vertical-unit metadata, the administrator must establish that elevations
are metres and explicitly confirm that fact. Viewer does not silently assert
units, overwrite the imported file, or retrofit guessed metadata onto older
imports. The immutable original already preserves authoritative encoded keys;
preflight retrieves those keys directly rather than trusting browser claims.
Unknown/unsupported vertical units remain blocked. Missing evidence cannot be
fixed by UI changes alone; obtain a documented source-unit declaration.

## Browser versus worker limits

Browser raster decode blocks remain capped at 64 MiB. Native staff calculations
can decode blocks up to the lesser of 256 MiB or one eighth of the configured
worker memory budget. Only the isolated measurement child decodes pixels; the
preflight reads headers only. The existing worker enforces singleton execution,
RSS/heap limits, timeout, authority/lease cancellation, source SHA-256 and
post-read identity checks. Native resolution and values are not downsampled.

GeoTIFF 3 metadata is read through its `getValue` / `loadValue` accessors, including
deferred strip/tile byte-count arrays. Browser and native preflight validate raw first-IFD
declarations before invoking the TIFF parser: at most 256 directory entries,
one million items per tag, 8 MiB per field and 32 MiB aggregate declared metadata.
This prevents malformed declarations from allocating unbounded deferred arrays.
Browser inspection requires exact bounded HTTP 206 ranges and reads response
bodies under a streaming size cap; a server ignoring Range is refused.
Real stripped and padded-tile fixtures verify block sizes and decoded results;
whole-image dimensions are not substituted for a tile's actual dimensions.

A requested small pixel window can still decompress an entire TIFF strip, so
native blocks larger than this ceiling are still refused. Such a source needs
a properly tiled native-resolution derivative prepared outside this workflow;
there is no promise that an admin job can accept every browser-refused raster.
Clients are not granted processing permissions to bypass these limits.

Known numerical fixtures cover fractional cell volume, native window agreement,
NoData, encoded feet and survey-foot conversion, missing units, higher bounded
native block allowance and rejection beyond that allowance. No real-world pile
volume or survey accuracy is certified by these fixtures.
