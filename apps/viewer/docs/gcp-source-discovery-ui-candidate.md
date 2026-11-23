# Detected CSV selection in the GCP panel

Source successor to server discovery PR #620. A finalized dataset's GCP panel
automatically checks the first bounded page of uploaded CSVs. Valid candidates
show filename and point count. Invalid files create no points; unavailable files
receive a short warning. More CSVs and refresh are explicit actions, not a new
polling loop. Manual original-file import remains available.

Processing writers can review and use a detected file without re-uploading it.
The existing preview supplies coordinate system, vertical datum and linear units
for an explicit confirmation. Successful imports select the saved set and refresh
the task. Source/hash-matching saved sets show as already imported. Read-only
staff see detected files without an import control.

Read requests are single-flight and cached with at most 32 dataset pages.
Unresolved import receipts are separately bounded at 32 and retain identical
payload/key across lost or malformed responses. There are no automatic writes
or retries. Preview objects are privately bound to their original authorization
epoch, exact dataset/source/format/hash/count/filename/token/provenance. A dialog
opened before a token change or auth clear cannot create a new request under a
replacement session. Task/source and current write status are checked across
the dialog too. The guarded transport checks before dispatch and after parsing,
so an old 401 cannot clear a newer session.

An unresolved import is fenced after auth changes. Saved-set review is required;
it is not automatically replayed under new authority. Receipts are in-memory,
not durable across browser reloads. A reload is not evidence that an uncertain
import failed; review saved sets before creating another. This is not a promise
of cross-session durable import reconciliation.

Sixty-five lightweight tests pass across UI controllers/light DOM fakes, actual
workspace transport in a VM, parser/discovery/original-retention SQLite/HTTP and
existing workspace regressions. Source review found and resolved preview
confirmation crossing auth epochs. An isolated reauthorization fixture now
checks one-time discovery clearing while preserving uploads on expiry.

No browser/render/build/native/server work occurred. Actual appearance, bundled
assets, 50-foot/default integration #553, manual numeric fix #579, large
map/photo marking, CRS/datum/units, NodeODX submission and installed staging
acceptance remain required. The shared post-response guard matches the fix in
JPG UI #616; Merger must preserve both modules' auth cleanup and one guard when
combining the independent candidates. No new schema or permissions are added.
