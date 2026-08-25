# TrueNAS unified thumbnail queue renderer

The repository-owned `queue-worker` image runs
[`thumbnail-worker-supervisor.sh`](thumbnail-worker-supervisor.sh), which starts
a bounded pool of isolated
[`thumbnail-queue-worker.sh`](thumbnail-queue-worker.sh) processes. Each process
claims one exact-version image, PDF, or video job from the authenticated
Operations renderer API, renews its opaque lease, uploads one metadata-free
`320x240` WebP, and reports completion.

This is the primary renderer for direct browser and other R2-only uploads. The
Cloudflare Container remains a delayed still/PDF fallback. The older
`includeKind=video` claim remains compatible with already-deployed workers, but
new images use the explicit `includeKind=all` contract.

## Resource and transfer policy

- `LTDSTHUMB_WORKER_CONCURRENCY` defaults to four and is bounded from one
  through eight. Slots share one pool across images, PDFs, and videos.
- `/scratch` and `/cache` must be Docker `tmpfs` mounts owned by the non-root
  renderer user. Every slot has a separate directory, lock, lease, heartbeat,
  and cleanup lifecycle.
- Images up to 512 MiB and PDFs up to 256 MiB are downloaded through the exact
  leased Operations source URL into RAM. The downloaded byte count must equal
  the claimed source size. libvips renders images; Poppler rasterizes PDF page
  one before libvips renders it.
- Videos up to 10 GiB are never downloaded as complete files. FFprobe and
  FFmpeg read a validated short-lived R2 URL through a loopback-only range
  proxy. Each video attempt has a 512 MiB aggregate upstream-read budget so
  formats with metadata or keyframes near the end can seek safely without a
  fixed-prefix assumption.
- Outputs are static WebP, exactly 320 by 240, no larger than 128 KiB. The
  Operations API validates the output again before storing and completing it.

## Deployment

Use the digest-qualified `ltds-thumbnail-queue-worker` reference published by
the **Publish TrueNAS thumbnail renderer images** workflow. Configure the
`queue-renderer` service from `compose.truenas.yaml`; do not mount a Jobs dataset
or grant R2 credentials. It needs only the dedicated renderer bearer and,
when using the Access-protected Operations host, the paired Cloudflare Access
service-token fields.

The normal API base is
`https://incoming.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1`.
The worker emits bounded startup, claim-kind/size, completion, and safe error
codes. It never logs source paths, object keys, URLs, ETags, thumbnails, or
credentials.

## Verification

Run from `apps/thumbnail-renderer`:

```text
npm run check
npm test
npm run test:video-worker-container
```

The local container smoke builds the exact `queue-worker` target and exercises
JPEG, PNG, PDF, long-video, short-video, authenticated Operations-proxy video,
tail-metadata video, and an authoritative `video/mp4` object with a misleading
`.jpg` name through claim, source transfer, render, heartbeat, upload, and
completion over local mock HTTPS. The release workflow repeats that canary
against the exact registry digest before creating its deployment receipt. No
client media or production service is contacted by the synthetic canary.
