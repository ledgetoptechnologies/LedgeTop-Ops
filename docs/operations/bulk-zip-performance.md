# Large resumable ZIP preparation

Download All produces a stored (uncompressed) ZIP64 artifact in R2 before
handing it to the browser. Keeping a stable completed artifact permits ordinary
browser Range/If-Range resume. It is intentionally not a live one-shot ZIP stream.

## Performance and integrity

- Preparation reads the pinned source versions for CRC-32, then reads them
  again for archive assembly. A 30 GB selection therefore requires roughly
  60 GB of source reads and 30 GB of archive writes, excluding retries.
- Independent checksum work runs in windows of four (at most 32 MiB of source
  buffers); chunks of the same file remain ordered. Two 16 MiB multipart parts
  upload concurrently (up to approximately 64 MiB of output/range buffers).
  These are payload bounds, not total isolate memory bounds: metadata and the
  runtime require additional memory. Never use one promise per selected file.
- Every source read retains its ETag condition and exact-length check.
  Failed parallel siblings drain before artifact cleanup begins.
- Durable progress checkpoints follow completed work, not scheduling order.
  The UI separates Checking files from Building ZIP; its percentage describes
  preparation, not bytes received by the browser.
- The original snapshot remains immutable. The final checksum manifest uses
  `<snapshot key>.final.json`. Failure, expiry, and orphan cleanup cover both;
  active jobs protect both from orphan cleanup.
- Multipart reads seek into the sorted ZIP segments instead of scanning the
  entire file list for each part. CRC uses an indexed byte loop with unchanged
  standard CRC-32 and incremental semantics.

## Rollout and operational checks

Do not replace a running Workflow without checking its version/replay state.
Jobs created by the older implementation may have overwritten their snapshot;
those jobs must not be silently treated as new-format jobs. Closing a browser
page only stops observing preparation; it does not cancel the server Workflow.
Cancel only an explicitly authorized exact job, never its source objects or
public share. Retain already completed archives and their resume URLs.

Validate one ZIP across file/header/central-directory boundaries, short or
changed source failures, out-of-order completion, partial replay, failed-sibling
draining, and GET/HEAD/Range/If-Range/revocation regressions before release.
Then observe a new representative large job's timestamps and byte/file counters.
Local mocked concurrency and checksum timings do not prove production throughput.

On September 3, 2026, a metadata-only check found the reported 4,809-file job
running with 31,696,036,253 source bytes and no error code. At 19:24:21 UTC,
450 files had completed CRC and weighted progress was 1,780,693,122 bytes.
No source files or public bearer links were read for that check.

A local Node 24 microbenchmark over 64 MiB measured the existing byte iterator
at 343 ms and the indexed loop at 94 ms, with identical CRC results. This is
CPU-only development evidence, not a promised end-to-end speedup.

The local change has no migration, credential, access-policy, or feature-flag
changes. Publication must still pass the repository's release checks; the
separate pending portal eligibility release must not be bundled into this fix.

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
