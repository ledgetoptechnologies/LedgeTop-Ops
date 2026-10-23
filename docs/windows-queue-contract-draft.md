# Windows durable read queue draft

This is backend and transfer-core work; Claude owns the desktop interface.
No route activation, live grants, production deployment or installer is implied.

The queue must never persist JWTs, cookies, expiring download URLs or current
download handles. Store an opaque non-authorizing resource reference, the
server-derived principal binding, a trusted source alias, an absolute local
destination, and pinned logical identity/name/length/ETag/SHA256. The resource
reference only selects a resource: server authentication and fresh current
authority remain mandatory on every resolution and byte request.

## Source boundary

A configured source has one fixed HTTPS origin and a stable local alias, with
employee and portal adapters sharing the verified Downloader. A session read
returns a purpose-separated opaque principal ID (`odqp1_` plus64 lowercase hex)
and expiry. The ID binds the exact origin, Access issuer/audience, human subject,
and native admission epoch where available; it is not authorization.

The source adapter exposes session discovery and resource resolution. Resolution
returns the principal ID together with a fresh DownloadSpec. The server must
reject a reference for another person, changed/revoked grant or root remap.
Reference claims pin the relevant grant lifecycle and resource identity; renewing
a publication must not silently substitute a different client or resource.
References are encrypted, purpose-separated from byte handles, bounded and
expire after at most30days. They contain no standalone byte authorization.

The unmounted source factories use `/api/staff/files/queue` and
`/api/client/operations/data/queue`. GET `/session` returns exactly
`{schemaVersion:1,principalId,expiresAt}`. GET `/reference` accepts the current
employee root/path or current portal file handle and returns exactly
`{schemaVersion:1,principalId,resourceRef}`. Creating a reference does not prepare
a second full-file copy. GET `/resolve?resourceRef=...` returns exactly
`{schemaVersion:1,principalId,manifest}`, where manifest is the existing nine-field
verified descriptor. Only resolution prepares the fresh transfer snapshot.

A source session change cancels and drains active work before another identity
can use the queue. After restart, no transfer begins until the source verifies
the current human session. A changed principal hides and blocks the old queue;
an expired session requires explicit sign-in. Never launch a browser from retry.
The authenticated byte route independently prevents a token switch during a
transfer setup from giving a new human the previous person's files.

## Durable state and lifecycle

Use one app-owned state directory and a process-held exclusive lock, with
bounded, duplicate-free versioned JSON and atomic replace. Reject reparse paths,
unknown/unowned state, malformed records and oversized queues. Persist no
runtime callbacks or secret-bearing network objects. On restart, an interrupted
Running job recovers to Paused and requires fresh source authorization.

Expose queue operations for enqueue, pause, cancel, explicit retry and one active
transfer at a time. Progress is supplied by Downloader; do not invent progress
or replay persisted byte counts as verified content. Existing owned partials are
validated by Downloader on each restart. Cancellation preserves completed files.

Resolve a fresh manifest for every start/retry. Require matching principal and
logical identity. Resume only when version, length, ETag and SHA256 match the
saved pin. A changed version enters VersionChanged and leaves old partials
untouched until an explicit new job is selected. Never overwrite completed user
files. A failed durable state write must not start a new transfer or silently
discard a completed file.

If a crash leaves a Running record but the verified file was already promoted,
restart marks that job as requiring recovery. After fresh session and exact
remote pins, inspect the existing regular local output without writes: match its
length and streamed SHA256 while denying concurrent writes, then recheck the
human session. Identical bytes may be recorded Completed without a network
download. Mismatched files stay untouched and require intervention. New jobs
must still refuse an existing output. Ambiguous temporary state or missing owned
state is a separate fail-closed recovery condition, not permission to delete it.

## Portal continuity still to qualify

The initial portal reference retains all recipient, grant, target, project and
publication lifecycle pins. An ordinary publication change can therefore return
409 even when content is unchanged. Do not discard pins to hide that result.
Autonomous queue resume across publication refresh remains required product
work: establish a producer-side continuity proof that preserves the person,
grant lifecycle, client and exact resource while adopting the new publication.
Current conservative rejection is an explicit unfinished gate, not the final
client experience.

Acceptance must cover restart, expired/changed identity, revocation, handle
renewal, same-content resume, changed content, pause/cancel, storage failures,
malformed/unowned state and concurrent queue instances. Use synthetic files and
actual local filesystem persistence; no live credentials or NAS data.
