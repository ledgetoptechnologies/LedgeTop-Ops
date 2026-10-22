# Employee file gateway protocol v1 (implementation in progress)

This is a private Ops-to-container protocol, not a desktop credential. The
desktop authenticates as the human against Ops. Ops must obtain and recheck
native staff admission plus an explicit exact-root read grant; directory-profile
permissions and an administrator role alone do not authorize file bytes.

Transport is POST to exactly `/v1/read`, over one configured HTTPS origin. No
redirects, user-selected backend URL, human JWT forwarding, writes or deletes.
Gateway instances have distinct IDs and a dedicated signing key, never a Viewer
or MCP key. The request body is at most 16 KiB, UTF-8 JSON with unique keys and
exactly these properties:

```
schemaVersion: 1
gatewayId: canonical UUID
rootId: canonical UUID
rootGeneration: positive safe integer
rootFingerprint: 64 lowercase SHA-256 hex characters
staffId: native staff ID
accessSubject: exact verified native Access subject
admissionVersion: positive safe integer
profileVersion: positive safe integer
grantId: canonical UUID
grantGeneration: positive safe integer
operation: "list" | "manifest" | "content"
path: canonical relative slash-delimited path (empty only for root listing)
expectedSha256: null for list/manifest, 64 lowercase hex for content
range: null, or {start: nonnegative safe integer, end: nonnegative safe integer}
cursor: null, or an opaque bounded list-page cursor (list only)
snapshotId: null, or a canonical UUID for a prepared immutable copy (content only)
expiresAt: Unix seconds
deadlineAt: Unix seconds
```

Only content permits a range, inclusive and start <= end. Paths disallow empty,
`.` or `..` components, backslash, percent, colon, controls, surrogates, leading
or trailing slash; maximum 4096 UTF-8 bytes, 64 components, 255 bytes/component.
These are opaque Linux source names, not Windows output paths. Windows filename
sanitization belongs to the adapter's manifest contract.

Headers: `Content-Type: application/json`, `X-Ops-Read-Key-Id` (1..64 ASCII
alphanumeric/underscore/hyphen), `X-Ops-Read-Time` (canonical Unix seconds),
`X-Ops-Read-Nonce` (32 lowercase hex), `X-Ops-Read-Signature` (64 lowercase hex).
Signature is HMAC-SHA256 with a dedicated minimum-32-byte key over these UTF-8
lines, without a final newline:

```
ops-employee-read-v1
<gatewayId>
<keyId>
<timestamp>
<nonce>
POST
/v1/read
<lowercase SHA256 of exact body bytes>
```

Gateway validates signature using constant-time comparison before disclosing
metadata. Timestamp within 30 seconds, timestamp <= expiresAt <= timestamp+30,
current time < expiresAt at request acceptance. `expiresAt <= deadlineAt <=
timestamp+900`; Ops also bounds deadlineAt by the verified human Access expiry.
deadlineAt bounds expensive snapshot work and is rechecked before a response.
Short request admission expiry must not impose a 30-second large-file copy limit.
Nonces are atomically claimed in a bounded durable
SQLite replay store until their expiry; saturation fails closed. Unknown fields,
duplicate JSON keys and noncanonical scalars are rejected. Content type and
content length are bounded; request transfer encoding is not accepted by the
initial HTTP adapter. Gateway rechecks deadlineAt after expensive work.

List returns exact `{schemaVersion:1, entries:[{name,kind:"file"|"folder"}],nextCursor}`,
at most 200 entries per page, sorted by UTF-8 name bytes. nextCursor is null only
at the end; otherwise it is a signed opaque cursor, at most 8192 ASCII characters,
bound to the exact staff/admission/profile/grant/root/path pins and an immutable
directory-name listing. Directory identity/timestamps are checked again on each
page; a changed, expired or evicted listing returns 409 and requires restart.
Listings support at least 100,000 entries subject to a configured bounded global
memory budget, lifetime and preparation deadline. No silent truncation.
List JSON is bounded to 256 KiB (including escaped
Unicode names); manifest JSON is bounded to 64 KiB. No symlinks/special files are returned. Manifest
returns exact `{schemaVersion:1,sha256,size,etag,snapshotId,snapshotExpiresAt}`, where etag is the quoted
lowercase SHA256. snapshotExpiresAt is Unix seconds on the gateway clock. Its
cache lifetime is at most 1800 seconds with a monotonic expiry; Ops allows the
same 30-second gateway clock margin when bounding this observed timestamp.
Content returns `application/octet-stream`, exact ETag,
Content-Length and, for ranges, 206 plus exact Content-Range. A digest mismatch
returns 412; an invalid/unsatisfiable range returns 416. Errors have static JSON
codes without backend paths, signatures, credentials or exception details.

The gateway opens paths beneath pinned root directory fds with O_NOFOLLOW and
rejects hard links, special files and nested mount IDs. Enrollment pins root
identity (device/inode and configured root ID/generation) into a fingerprint;
changed root mappings require re-enrollment and a new generation in Ops.

Read-only mounts do not make source bytes immutable. Hash into an unlinked,
private disk-backed snapshot, compare source stat identity/size/mtime_ns/ctime_ns
before/after copying, then return only snapshot bytes. Manifest prepares a copy
and retains it in a bounded temporary cache. Content requests must name its
snapshotId and expectedSha256; they reopen and stat-check the current source,
compare all source identity/size/mtime_ns/ctime_ns/link pins and exact request
authority, then read only that immutable cached copy. Missing/expired copies
return 409 so the client renews its manifest; changed source or hash returns 412.
Separate range readers use pread (or independent fd offsets); one reader must
not change another reader's position. Active leases retain their fd safely.
Disk quota, free space, cache entry count, preparation concurrency, bounded TTL,
eviction and cancellation must be enforced. No permanent second raw-photo archive
is intended. Manifest renewal may need a new preparation, but ordinary full/range
reads of a live prepared snapshot must not copy source bytes again. Initial
preparation latency and actual large-file throughput remain staging gates.
This private byte copy is not an atomic filesystem snapshot of a concurrently
written source. Stat timestamps can miss same-tick changes. The guarantee is
that returned bytes match the named prepared copy's advertised digest; content
must never substitute fresh source bytes under an old snapshot ID. A renewed
manifest can prepare a different copy after source changes. Atomic source-version semantics
need finalized immutable ingest or a separately reviewed snapshot mechanism.

Ops must recheck exact admission/profile/grant/root versions after the upstream
await, before metadata or byte handoff, and cancel an acquired body on denial.
Successful content start must be audited before bytes. Revocation cannot recall
bytes already delivered. Routes stay unmounted until joined tests, administrative
provisioning and deployment review are complete. No live NAS access is permitted
as part of developing this implementation.

This remains an unpublished v1 draft; nullable cursor and snapshot fields amend
the source pilot before any routes are enabled. No stable deployed wire contract
is being replaced. Every content request still passes current Ops authorization;
neither a cursor nor snapshot ID is a standalone access capability.
