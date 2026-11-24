# Dataset GCP CSV discovery — server candidate

Adds a read-only staff endpoint for finding GCP CSV files already uploaded with
photos. It does not import points, create a set, retain extra data on GET, queue
processing or infer missing coordinate declarations. UI wiring is still open.

`GET /api/v1/datasets/:id/gcp-source-candidates` requires `viewer.gcp.read` and a
finalized dataset. Pages default to two eligible indexed CSV/GCP-source files,
with a maximum of five and an explicit `nextAfterId` cursor. Each source is
limited to the existing 2MiB bound and verified against its registered hash and
size. Unknown/invalid/ambiguous content is ignored; unreadable or changed sources
are counted as unavailable. No raw content, sample coordinates or filesystem
paths appear in the candidate DTO.

Detection requires exactly one recognized header schema: Emlid All-columns or
generic CSV. Required numbers must be explicit finite decimal values. Hybrid
headers, blank numbers, malformed quotes, duplicate IDs, invalid ranges and
ambiguous units do not become candidate points. CSV row parsing now stops at the
existing point bound rather than building an arbitrarily large row collection.
Valid quoted commas, escaped quotes, multiline fields and CRLF remain supported.

The existing write-scoped preview/import endpoints also accept `sourceFileId`
without re-uploading its bytes. They resolve only an eligible file in that exact
finalized dataset, verify it again, require the detected format and retain the
existing Emlid confirmation requirement. Import verifies current raw bytes again
and uses the permanent-original store, preserving filename and source lineage.
Discovery is a hint; CRS/datum, units and map/photo marking still need review and
real NodeODX acceptance. No geodetic qualification follows from CSV recognition.

Thirty-four lightweight parser/discovery/original-retention checks pass using
synthetic data, actual SQLite, small CSV files and HTTP. They cover no-write GET
discovery, pagination, read/write scope separation, dataset/file substitution,
changed source after preview, required confirmation and preserved raw originals.
Independent findings on hybrid schemas and quoted-number concatenation were
fixed and rereviewed. No native/browser/build/staging/deployment ran.

This stacks on PR #618 and its migration46 prerequisite, with no new schema.
The existing 50-foot/default UI candidate #553 and manual numeric validation
candidate #579 remain separate integration requirements. Their branches are
unchanged; this detection path guards its own raw numeric fields. Merger must
preserve all fixes in the combined candidate. UI auto-discovery/selection,
complete GCP marking/submission and installed acceptance remain outstanding.
