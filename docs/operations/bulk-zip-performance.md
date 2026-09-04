# Large resumable ZIP preparation

Download All produces a stored (uncompressed) ZIP64 artifact in R2 before
handing it to the browser. Keeping a stable completed artifact permits ordinary
browser Range/If-Range resume. It is intentionally not a live one-shot ZIP stream.

## Performance and integrity

- New jobs write a stored ZIP64 archive with data descriptors. Each ETag-pinned
  source range is copied into the archive and, when needed, included in CRC-32
  in the same read. A 30 GB selection therefore requires roughly 30 GB of
  source reads and 30 GB of archive writes, excluding a retried Workflow step.
- Source reads are capped at 8 MiB and archive parts at 32 MiB. Non-final R2
  multipart parts have one deterministic uniform size; the final prefix
  remainder and ZIP64 directory share the final part. One part is built at a
  time, so memory and subrequests remain bounded. Never use one promise per
  selected file.
- Every source read retains its ETag condition and exact-length check.
  Failed parallel siblings drain before artifact cleanup begins.
- Durable progress checkpoints follow completed work, not scheduling order.
  The UI separates Checking files from Building ZIP; its percentage describes
  preparation, not bytes received by the browser.
- The original snapshot remains immutable. Checksum resolution is written to
  `<snapshot key>.resolved.json`, and the final checksum manifest uses
  `<snapshot key>.final.json`. Failure, expiry, and orphan cleanup cover all
  three; active jobs protect them from orphan cleanup.
- A checksum is reused only for the exact `(R2 key, raw ETag, size)` identity.
  A folder change rebuilds the archive fingerprint, while unchanged objects
  retain their cached CRC. Missing legacy checksums are calculated inline and
  persisted only after the file descriptor is complete.

## Completed archive reuse

The exact selection fingerprint includes the share ID and version, root,
ordered archive names, physical keys, raw ETags, and sizes plus the writer
format version. A completed candidate has a generation-specific R2 key. A
later exact selection can reuse it only while its D1 cache row is unexpired and
an R2 HEAD matches the stored ETag and size. Each download job still receives
its own seven-day authorization/resume window and every HEAD/GET/Range request
still checks the current share/version/revocation boundary.

Cache artifacts live for 30 days from last use. Hourly cleanup conditionally
claims an expired row before deleting R2, so a concurrent reuse extension wins
safely. Active jobs protect their archive even if another concurrent builder
became the canonical cache row. Orphan cache generations and checksums unused
for 180 days are pruned. Do not use a deterministic shared object key for an
in-progress multipart upload: replacing it would break an existing browser's
If-Range resume.

## Ingest checksum audit

Current browser multipart uploads, incoming quarantine/finalize, Dropbox/cloud
imports, and R2 CRUD copies establish server-verified size and R2 ETag, but do
not all produce a trustworthy ZIP-compatible CRC-32. A client-supplied CRC or
custom metadata value is not trusted. For now, the first ZIP read is the common
trusted checksum producer; all later folder builds can reuse it. Future ingest
optimizations may persist CRC only when the trusted server-side ingest process
actually observes every byte and binds the result to the final key, ETag, and
size. Copy paths may carry the checksum only after verifying that exact source
identity. This rule must apply to every ingest path before CRC-at-ingest can be
called complete.

## Rollout and operational checks

Do not replace a running Workflow without checking its version/replay state.
Jobs created by the older implementation may have overwritten their snapshot;
those jobs must not be silently treated as new-format jobs. Closing a browser
page only stops observing preparation; it does not cancel the server Workflow.
Cancel only an explicitly authorized exact job, never its source objects or
public share. Retain already completed archives and their resume URLs.

Validate one descriptor ZIP across file/header/data-descriptor/central-directory
boundaries, short or changed source failures, partial replay, concurrent
checksum versions, cache-hit/cache-miss races, and
GET/HEAD/Range/If-Range/revocation regressions before release.
Then observe a new representative large job's timestamps and byte/file counters.
Local mocked concurrency and checksum timings do not prove production throughput.

On September 3, 2026, a metadata-only check found the reported 4,809-file job
running with 31,696,036,253 source bytes and no error code. At 19:24:21 UTC,
450 files had completed CRC and weighted progress was 1,780,693,122 bytes.
No source files or public bearer links were read for that check.

A local Node 24 microbenchmark over 64 MiB measured the existing byte iterator
at 343 ms and the indexed loop at 94 ms, with identical CRC results. This is
CPU-only development evidence, not a promised end-to-end speedup.

The next cache release has one additive Delivery D1 migration and no credential,
access-policy, or feature-flag changes. Apply migration 0195 before activating
the new Workflow. Publication must still pass the repository's release checks;
the separate portal work must not be bundled into this change.

Local verification on September 3: 69 tests passed across ZIP, bulk backend,
bulk client, and concurrency suites. The 100 GiB single-file estimate is 24,009
steps; 10,626-file coverage still fits one archive. Mocked Workflow execution
checks checksum dependencies, drain-before-cleanup, cached replay, and split
parent replay without duplicate child creation. TypeScript and production
build passed. The progress browser fixture passed on desktop Edge and mobile
Edge with no horizontal overflow at queued/checking/building/ready stages.
These are local results; no large production throughput acceptance is claimed.

## September 3 maintenance deployment

The user explicitly approved a ZIP-only maintenance exception to the normal
portal release gate. The existing missing portal-signing configuration remains
a blocker for portal activation, not a change included in this release. The
preflight itself was not weakened. After the checks above and a successful
Wrangler dry run, commit `14d5fed` was deployed with `--keep-vars` at
19:47:38 UTC. No migrations, Access policies, secrets, or feature flags changed.

- Worker version: `bf225051-1e8e-49ae-9e4c-4457a2107494` (100%).
- Deployment: `fc37535f-5b03-4255-8a14-47218242b18f`.
- Prior rollback version: `1580d13d-d857-419d-8913-77c3edae40f0`.
- All Worker bindings matched the captured pre-deployment settings exactly.
- Both portal hosts returned HTTP 200 from `/health`; a synthetic public-share
  shell returned 200. This does not assert authorization for a real client link.
- The existing large Workflow remained running on its original version
  `a0b1d09e-0d60-4198-a310-961c38b7d41d`; it was not cancelled or migrated.

Use a newly created job for production performance acceptance. A new release
does not accelerate an already-running old-version job. No TrueNAS update is
needed for this Cloudflare-only change. The normal connected build may still
stop at the unchanged portal gate; the explicit manual maintenance deployment
above is the verified live release.
