# LTDS Resolve proxy generator

This package turns local editing originals into DaVinci Resolve proxies. It
replaces the loose host-mounted script with a repository-owned container image
and a Python standard-library supervisor. It does not generate thumbnails,
upload media, modify originals, or manage the Viewer.

Use [LTDS Proxy Generation](../media-generation/README.md) to run it with
the existing Operations thumbnail queue worker in one TrueNAS Custom App.
The runtime is copied into the Docker image at build time; installation
requires no host script bind or old proxy-script directory. Keep only the
Jobs and private state mounts specified in the deployment YAML.
The published package is `ghcr.io/ledgetoptechnologies/ltds-proxy-generator`.
The **Verify and publish Resolve proxy generator** workflow tests pull
requests, then publishes a commit tag, digest-qualified receipt and `:latest`
after a successful verified `main` build. Deployment YAML uses `:latest` with
`pull_policy: always`; commit tags and receipts provide traceability rather
than required deployment pins. Update/redeploy the app to pull the latest
verified release. A plain container restart does not pull, and no live
automatic updater is installed. The new package is available only after that
workflow has actually completed; this source change does not activate it on
TrueNAS.

## Output and compatibility

- QuickTime `.mov` using ProRes 422 Proxy, 10-bit 4:2:2, with PCM 48 kHz audio.
  This preserves the actual supplied script's codec; its older README described
  an H.264 implementation that the supplied script no longer uses.
- Half the source height, rounded to an even value, capped at 720 by default
  and floored at 144. Width preserves aspect ratio and remains even. A
  3840x2160 source produces 1280x720. The codec remains the lowest-bitrate
  ProRes profile; file size still depends on source content, duration, frame
  rate and audio. Use `PROXY_MAX_HEIGHT=540` for a smaller profile after a
  synthetic Resolve linking/quality check.
- The first video stream and all available audio streams are mapped. Rational
  frame rate, source timecode notation and video start offset are retained.
  The generator does not infer drop-frame timecode solely from frame rate.
- A source such as `Raw/clip.mp4` produces `Raw/Proxy/clip.mov`. It uses Resolve's
  sibling-folder convention. Two eligible files with the same case-insensitive
  stem in one folder are skipped because that convention cannot distinguish
  their destinations safely.

An output is probed before publication. The generator checks ProRes Proxy
profile, pixel format, expected dimensions, frame rate and available frame
counts, audio stream count, timecode when present, and bounded duration/start-time differences. Sources whose nominal and average frame rates differ
are deferred as unsupported rather than silently converted to a different timeline.
Publication uses an
atomic replacement only after checking that the source's device, inode,
size, modification time and change time remain unchanged. This is metadata-based identity,
not a full-file content hash. Confirm linking, audio and retiming in Resolve
with synthetic clips before switching the production library.

## Configuration

These are container environment values; the combined stack exposes most under
`LTDSPROXY_*` substitutions so they do not collide with thumbnail settings.

| Container value | Default | Purpose |
| --- | --- | --- |
| `JOBS_ROOT` | `/data/jobs` | Existing local Jobs mount |
| `STATE_DIR` | `/state` | Private persistent SQLite receipts, retries and lock |
| `MAX_CONCURRENT` | `6` | Simultaneous proxy jobs |
| `FFMPEG_THREADS` | `2` | Requested decoder/encoder threads per FFmpeg process |
| `PROXY_MAX_HEIGHT` | `720` | Maximum proxy height, retaining half-source scaling below the cap |
| `SLEEP_SECONDS` | `900` | Pause after each completed scan |
| `SOURCE_STABLE_SECONDS` | `60` | Minimum source age and unchanged observation window |
| `PROXY_SCAN_DIRS` | `Clients Recurring Extended 2024 2025 2026` | Whitespace-separated top-level directories |
| `PROXY_INCLUDE_SEGMENTS` | `Dump Unedited Raw Stabilized` | Eligible directory segments, case-insensitive |
| `FORCE_PROXY_REGENERATION_VERSION` | `6` | Per-file output revision; preserve during ordinary upgrades |
| `PROBE_TIMEOUT_SECONDS` | `30` | Deadline for each FFprobe process |
| `ENCODE_TIMEOUT_SECONDS` | `7200` | Deadline for each FFmpeg encode |
| `MAX_ATTEMPTS` | `3` | Failed attempts before deferring that source/version |
| `RETRY_BASE_SECONDS` | `60` | Initial persistent retry backoff |
| `RETRY_MAX_SECONDS` | `3600` | Maximum retry backoff |

The default pool can use substantial CPU and disk bandwidth. FFmpeg thread
counts are requests to its processing stages, not a hard total process-thread
limit; the container CPU/memory limits and pool size control aggregate load.

## Scan and failure behavior

New or changed sources need two unchanged observations separated by the
stability window. On a new installation the first pass records observations;
normally processing begins on a later scan, after the default 15-minute pause.
Scans do not launch another pass while the current pass is running. A long
batch therefore makes the interval longer than 15 minutes.

The scan excludes proxy folders, previews, hidden paths, temporary/recycle/
snapshot folders, archives, maps/models, Avata RAW variants, and the existing
deliverable/export/final/output/render folder names. It does not descend into
symlinks or a different filesystem. A source whose configured top-level folder
is a different mounted filesystem is not part of the intended single-dataset
layout; keep the Jobs mount and scan directories explicit.

Each probe and encode has a finite deadline. Timed-out or stopped child
process groups are terminated, failed outputs stay unpublished, and the
generator cleans its own attempt's temporary output. A failed file does not
prevent later files from being processed. Retry state persists across
restarts; backoff is checked on subsequent scans rather than creating a
separate scheduler. Originals and existing proxy files are never pruned by
this package.

The persistent state directory also holds the single-instance lock. All
instances targeting the same Jobs tree must share that state directory;
different state directories cannot coordinate their locks. Do not run the
legacy script alongside this app. Logs contain fixed events and counts,
without client media paths or FFmpeg command lines. The image healthcheck
requires a recent supervisor heartbeat, including during idle sleep and
while waiting for jobs; inspect scan outcome counts and actual media as well.

## Adopting existing proxies

The smaller default profile uses `FORCE_PROXY_REGENERATION_VERSION=6`; the
supplied script used revision five and a 1080 cap. Start migration with a
narrow synthetic scan scope and concurrency one, not the entire library.
On a source's first discovery the generator can adopt an
existing newer proxy after compatibility checks if the folder has no legacy
version marker or has the matching version marker. A mismatching legacy
folder marker prevents adoption. It records a per-file receipt after
successful adoption or generation; it does not mark the whole folder as
complete before the work finishes.

A known source whose identity changes must be processed again. Receipts also
track the render profile: changing the maximum height requests an updated
output for tracked sources. An intentional version bump requests regeneration
of tracked outputs. Keep state across
upgrades so receipts and failure history remain reliable. If state is lost,
healthy existing legacy outputs may be adopted again on first discovery;
resetting state is not a reliable way to request regeneration. This migration
does not delete old proxies or the old generator script.

## Local verification

From the repository root:

```text
docker build --target test -t ltds-proxy-generator-test apps/proxy-generator
docker run --rm --network none ltds-proxy-generator-test
python apps/media-generation/test_compose.py
```

Tests use generated synthetic media and isolated temporary directories. The
Compose test only renders configuration with synthetic values; it neither
starts containers nor mounts a server dataset. `--once` runs one observation/
processing pass and exits; it still honors source-stability checks.
