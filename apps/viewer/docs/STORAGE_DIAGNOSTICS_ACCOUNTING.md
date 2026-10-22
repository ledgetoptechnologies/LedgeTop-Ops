# Storage diagnostics accounting

The Diagnostics cards no longer present filesystem-wide used capacity as four
different folder sizes. The legacy `/api/v1/storage` `storage` DTO remains intact
for capacity/reservation clients; the additive `usage` DTO is a separate census.

## Scope and categories

The census measures regular files beneath configured datasets, models, cache,
trash, dataset-import and Terra-import roots. It does not traverse external
WebODM media roots, ZFS snapshots, or arbitrary parents. Database/WAL files and
other application data outside these configured roots are explicitly excluded.
This is **logical regular-file size**, not ZFS allocated/compressed size, and it
does not include directory metadata. The result is therefore an estimate to
compare with TrueNAS, not a claim of identical physical accounting.

Categories sum to the total without overlap:

- Sources: registered original camera photos, uploaded dataset source inputs,
  and retained-manifest `source_photo` members (including copies in model roots).
- Model products: registered 3D tiles/GLB/EPT/point-cloud/ortho/DSM/DTM files,
  hierarchical manifest members, and exact retained-manifest mesh OBJ/MTL/texture
  and point-source members. Image extensions alone never identify original photos.
- Temporary cache: cache and import-drop contents, including retained ZIPs and
  active staging. Measurement does not declare these files disposable.
- Trash: recoverable files in the trash root.
- Other: remaining files, including unregistered artifacts, metadata, and reports.

Nested/identical roots and hardlinks are counted once. Live source/product
classification wins over aliases in temporary cache or trash. This is attribution
of unique bytes, not a promise that deleting a particular alias frees those bytes.
Shared filesystem capacity is displayed separately, once per filesystem device.

## Workload and failure behavior

The endpoint returns immediately with `pending` on first use and starts one
coalesced asynchronous scan. Results are cached for five minutes; old results stay
visible as stale during refresh. While Diagnostics is visible, a single-flight
storage-only poll every 2.5 seconds replaces only the cards when measurement
finishes; expanded run panels are preserved. Polling stops on completion, page
hide, leaving Diagnostics, authorization loss, three consecutive failures, or
300 requests. Manual Refresh restarts a paused polling cycle.
The sequential scanner pauses 100 ms per 100 entries, caps at 500,000 entries,
10 minutes and depth 128, and never hashes/reads file contents or mutates files.
Registry classification uses keyset pages of 250 rows, releasing each SQLite
statement before yielding, rather than keeping an iterator open across imports.

Symlinks, special files, unavailable roots and changed files generate explicit
partial warnings. Permission failures do not become trustworthy zeroes. A partial
total is the observed lower bound. Scanning is not an atomic filesystem snapshot:
an active import can add or move files during the measurement. The timestamp and
scope must accompany any comparison. Files beyond a scan limit remain unmeasured.

The run timeline also exposes the sanitized cleanup event `details.reason`, so
an incomplete supersession proof is not mistaken for a generic processing failure.
Storage diagnostics itself does not trash, purge, re-import, or pause work.

## Regression checks

`node --test test/storage-usage.test.js test/storage-usage-api.test.js test/workspace-project-dashboard.test.js`

Coverage includes exact category sums on one filesystem, hardlinks, nested roots,
import ZIPs, external symlink rejection, partial scan limits, registry source versus
texture classification, nonblocking/coalesced refresh, authenticated additive API
behavior, active staging preservation, and UI pending/partial/capacity labels.
