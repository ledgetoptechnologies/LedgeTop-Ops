# Delivery image-location maps

## Privacy and authorization contract

The photo map is an authenticated delivery-folder aid. It is available only
after the same per-request folder, project, account, membership, assignment,
and trash checks used by the surrounding Operations or client-portal file
view. Operations authorizes the exact requested folder prefix. The client
portal derives its scope from current active project or direct-folder grants;
revoked memberships and grants stop contributing immediately.

No `/api/public/*` route exposes image locations. Public shares, generic
delivery sessions, expired/revoked shares, unauthenticated requests, and
cross-client selectors receive no map data in this release. Introducing public
coordinates later requires a separate, deliberate policy and security review.
Map responses contain only grouped latitude, longitude, and image counts. They
never contain R2 keys, ETags, raw EXIF, device data, camera direction, file
names, or original-file URLs. Existing original/private and thumbnail-only
access behavior is unchanged.

The browser sends the authorized point viewport to the configured Mapbox map
service to fetch tiles. Operators must treat that third-party request as part
of the privacy review and use the existing restricted public Mapbox token.

## Extraction and version lifecycle

GPS parsing runs in the existing `image-thumbnail.v1` queue consumer, after the
R2 create/copy event has been indexed. Viewer requests never read or parse an
original. The consumer performs one bounded (512 KiB) conditional range read,
validates TIFF GPS references/rationals and WGS84 bounds, rounds coordinates to
six decimal places, and stores only the validated point. Location timestamps
are not retained. Missing or malformed EXIF becomes a terminal `absent` or
`invalid` row and does not fail thumbnail processing.

Rows are bound to the exact R2 source key and ETag. Queue leases and terminal
states make retries idempotent. A new ETag clears the prior point before the
replacement is parsed, so the old version cannot remain visible. A bounded
scheduled backfill reuses the existing thumbnail queue for already indexed
images and retries transient failures without introducing another queue.

Folder queries join the location row to the current `file_index` ETag and exact
folder prefix, require an image media kind and `ready` state, and exclude active
exact or prefix tombstones. Results are capped at 500 authorized images and
group identical rounded points. The client portal's Past deliveries view is an
explicit aggregate of all currently authorized direct-folder roots; its label
does not imply that the files belong to one physical folder.

## Retention, deletion, and revocation

- Object replacement immediately invalidates the old point through the ETag
  mismatch and resets extraction state for the new version.
- Successful file, batch, and folder moves synchronously delete the old
  source key's location and index rows for the exact pre-move ETag. Because R2
  has no conditional delete, the copied source version is atomically replaced
  with a private zero-byte move marker using `etagMatches`; it is never removed
  with an unconditional delete. Listings, source delivery, reconciliation,
  bulk downloads, and file events ignore that marker. A concurrent replacement
  makes the conditional write fail and survives unchanged; a later upload can
  safely overwrite the marker and enter the normal index/thumbnail lifecycle.
- Object-removal events and reconciliation delete the location row with the
  `file_index` row as an idempotent fallback. Foreign-key cascading is the
  final consistency guard.
- Trash tombstones hide locations immediately. Permanent trash purge deletes
  exact/prefix location rows before deleting index rows.
- Grant, membership, or share revocation changes authorization rather than
  source retention. The point remains attached to the private asset for other
  still-authorized viewers but is no longer returned to the revoked viewer.
- Restoring a trashed, unchanged asset permits its current version-bound point
  to reappear; a replacement must be reprocessed.

## Cloudflare and staging prerequisites

Apply Delivery migration `0109_image_asset_locations.sql` before deploying a
Worker that writes or reads location state. No new binding is required: the
feature reuses Delivery D1, the private R2 bucket, `ltds-thumbnail-jobs`, its
DLQ, the Operations 15-minute scheduler, and the existing Mapbox public token.
Confirm in isolated staging that the R2 create notification still feeds the
file-event queue once, the thumbnail producer/consumer/DLQ bindings resolve to
the intended staging resources, D1 foreign keys are active, and the scheduler
is installed. Run the bounded backfill only against staging data and verify
retry/DLQ behavior before considering production approval.

Cost capacity should include one bounded R2 Class B read and D1 state changes
per image version, queue operations for new images and backfill retries, D1
reads for authorized folder views, and Mapbox tile usage in browsers. There is
no additional R2 derivative and no Cloudflare Images transformation solely for
the map. Review current Cloudflare and Mapbox pricing/limits during staging;
repository configuration does not prove account entitlements or quotas.

## Limitations

- GPS extraction currently recognizes bounded JPEG APP1 EXIF, TIFF, PNG eXIf,
  and WebP EXIF. HEIC/HEIF, AVIF, GIF, and video geotags are not parsed.
- EXIF located after the first 512 KiB is treated as unavailable.
- There is no camera orientation/direction, raw EXIF inspector, capture-time
  display, clustering beyond identical coordinates, reverse geocoding, route
  planning, offline map, or public-share map.
- Coordinates reflect available image metadata and can be missing, stale, or
  inaccurate. They are not evidence of flight path, launch location, property
  access, or regulatory compliance.
- Local and browser tests do not constitute live Cloudflare, Mapbox, staging,
  or production verification.
