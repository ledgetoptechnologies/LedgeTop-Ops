# Durable orthophoto JPEG jobs: source increment

Owner: Model Viewer chat01a16728-6f90-7fa2-9968-3883d150dd83. Branch
codex/viewer-ortho-jpg-jobs-20261114, parent9e918c87ed517c301fdd20011ea567c1f2b05700
from PR597. Merger reserved migration47 `viewer_orthophoto_jpeg_jobs` for this
candidate;43foundation/44hierarchy/45held-upload/46GCP remain separate. Historical
47 proposals are not promoted by this reservation. No runtime migration occurred.

The queue binds an existing current ready model/version and orthophoto asset's
ID, hash, bytes, location and storage mode, plus converter SHA, encoder SHA,
fixed cjpeg/no-optimize policy and full pixel dimensions. Imported models need
no processing attempt. Exact requests deduplicate. Source or policy changes
create different identities. Inactive historical versions are not supported by
this source increment and require a separate authorized design if exposed.

Only one JPEG job may be leased or awaiting cleanup across this queue. Expiry
becomes `cleanup_required`; it does not permit another worker to take over while
the original process may exist. Completion and heartbeat require the original
owner/token, live lease and unchanged deadline/source bindings. Explicit retry
requires the original identity plus a closure-evidence hash. Append-only events
retain the old identity across retry. Source purge is not blocked by a foreign
key to this history; missing/changed sources cannot publish a stale success.

These are database invariants, not execution admission. Worker validation and
closure hashes are a trusted internal seam: this repository cannot prove file
contents, process termination or receipt authenticity merely from a JSON/hash.
It grants no permissions and exposes no new HTTP route. Raw rows include private
paths/lease tokens; future API serializers must return only a minimal public job
status. Dimensions must come from validated server-side source metadata, not a
client claim. Serializing this queue does not serialize all other Viewer jobs.

Six tiny serial in-memory tests pass with a128MiB Node heap. They use ordinary
database startup47 and its real ledger, without a manual migration fallback.
Coverage includes imported/no-attempt identity, exact success deduplication,
source drift, global lease/cleanup fencing, stale owner/token/deadline rejection,
encoder/converter/policy/dimension/result bindings and immutable retry evidence.
No images, codecs, GDAL, native children, filesystem fixtures or servers ran.

Remaining: combined migration upgrade acceptance, authorized request/status API,
worker/heartbeat/coexistence admission and hard resource limits, physical closure
reconciliation, atomic verified product registration, current download authority,
existing-model UI and admitted real-image qualification. Do not enable a worker
lane from this source increment or treat `succeeded` as independent acceptance.
Preserve original TIFF, failed evidence, existing ACL and48-hour frontend assets.
