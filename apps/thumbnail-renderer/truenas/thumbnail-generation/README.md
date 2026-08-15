# TrueNAS video thumbnail generation

[`thumbnail-queue-worker.sh`](thumbnail-queue-worker.sh) is the canonical,
version-controlled script to copy into the FFmpeg container at
`/scripts/thumbnail-queue-worker.sh`.

The script accepts the retired Incoming renderer URL only as a migration aid
and immediately replaces it with the canonical Operations renderer endpoint.
It requires the dedicated renderer bearer. Cloudflare Access service-token
values are optional and are sent only when both are configured. `/scratch`
must be a Docker `tmpfs` mount.

Videos are not downloaded as complete files. A loopback-only range proxy holds
the validated, short-lived R2 GET URL and streams only FFprobe/FFmpeg's requested
byte ranges. FFmpeg selects the frame at five seconds when the clip is at least
five seconds long; shorter clips use their midpoint. Only small control files
and the bounded WebP output are written to the RAM-backed scratch directory.

Do not place credentials in this directory, Compose YAML, logs, or screenshots.
Configure these runtime values using the TrueNAS application environment or
secret fields:

- `LTDSTHUMB_API_TOKEN` (or `THUMBNAIL_INGEST_SECRET`)
- `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (optional paired values)

The canonical API base is
`https://ops.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1`.
