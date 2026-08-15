# TrueNAS video thumbnail generation

[`thumbnail-queue-worker.sh`](thumbnail-queue-worker.sh) is the canonical,
version-controlled script to copy into the FFmpeg container at
`/scripts/thumbnail-queue-worker.sh`.

## Production-verified baseline

The current script was verified in production on **2026-08-15** and is the
known-good TrueNAS video-thumbnail worker. Its SHA-256 is:

```text
F056F7F6ED458BE4A3A700B601F430BBAE237FF44F30A8C630BD8642D28BE10D
```

Treat that exact file as locked infrastructure. Do not rewrite, simplify, or
replace it as part of unrelated thumbnail, delivery-page, or Cloudflare Worker
work. Any future script change must be intentional and must rerun the complete
`test:video-worker-container` suite for both the eight-second (five-second
frame) and four-second (midpoint frame) scenarios before deployment. Keep the
Docker/Compose configuration unchanged unless a separate container change is
explicitly requested.

The machine-facing renderer endpoint is on the Incoming hostname and requires
the dedicated renderer bearer. The Access-protected Operations hostname is
also accepted only when both Cloudflare Access service-token values are
configured. `/scratch` must be a Docker `tmpfs` mount.

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

The normal API base is
`https://incoming.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1`.

Run `npm run test:video-worker-container` from `apps/thumbnail-renderer` to
exercise the worker in the pinned FFmpeg container against local mock HTTPS
claim, R2-range, upload, heartbeat, and completion endpoints. The smoke test
uses synthetic eight-second and four-second videos and writes only to a
disposable container tmpfs.

The final operator copy is also placed at
`C:\Users\fstor\Downloads\temp\thumbnail-queue-worker.sh`. Before installing
it, compare its SHA-256 with the known-good value above. A mismatch means the
copy must not be deployed.
