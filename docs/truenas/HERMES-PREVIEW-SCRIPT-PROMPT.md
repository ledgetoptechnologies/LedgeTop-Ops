# RETIRED — do not use: LTDS TrueNAS preview generator

This prompt is retained only as rollback history. The product now uses the
[Cloudflare thumbnail-only pipeline](../media-thumbnail-pipeline.md). Do not
generate or upload any of the derivatives described below.

I need you to create, test, and harden the production TrueNAS Scale preview-generation script used by the LTDS Cloudflare Operations and Delivery Workers.

Use my attached/current `preview-gen.sh`, `docker-compose.yml`, and TrueNAS directory mappings as your starting point. You understand my TrueNAS deployment better than Codex, so adapt the container setup safely, but the output contract below is authoritative because it matches the deployed Workers.

## Goal

Generate lightweight WebP artifacts locally on TrueNAS before TrueNAS Cloud Sync uploads the source tree to the `client-data` R2 bucket. Do not upload to R2 from this script and do not add R2 credentials to the FFmpeg container. TrueNAS Cloud Sync remains responsible for uploading both originals and the hidden `.previews` directories.

The script must be safe, idempotent, resumable, resource-bounded, and compatible with the restricted TrueNAS Scale environment. All processing should happen inside the existing container. Do not require Python.

## Source mapping

- Local root: `/data/jobs`
- R2 root represented by that directory: `Jobs`
- Process only files below `/data/jobs/Clients/`.
- A local source such as:

  `/data/jobs/Clients/Acme/Edited/IMG_0042.JPG`

  maps exactly, including case, to:

  `Jobs/Clients/Acme/Edited/IMG_0042.JPG`

- Skip every directory whose exact path segment is `.previews`, `Dump`, or `_ltds`, case-insensitively.
- Also skip temporary, lock, proxy, trash, snapshot, and incomplete-upload directories.
- Never recurse into generated artifact directories.
- Do not process `Jobs/Demo`, `Jobs/Extended`, or `Jobs/Edited Vs. Nonedited`; the current Workers only register artifacts under the case-sensitive prefix `Jobs/Clients/`.

## Supported media

- Images: `avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `tif`, `tiff`, `webp`
- Videos: `mp4`, `m4v`, `webm`, `mov`
- Documents: `pdf`
- Extension checks should be case-insensitive.
- Skip HEIC/HEIF for now and log them clearly; the current Workers classify those formats as unsupported.

## Required artifact paths

For every source, take only its leaf filename, including extension and original case. Normalize that filename to Unicode NFC, encode it as UTF-8, calculate SHA-256, and use the lowercase hexadecimal digest as `<hash>`.

Do not hash the full path. Do not add a newline to the hash input.

For an image or PDF:

```text
<source-parent>/.previews/<hash>/thumb.webp
<source-parent>/.previews/<hash>/preview.webp
<source-parent>/.previews/<hash>/manifest.json
```

For a video:

```text
<source-parent>/.previews/<hash>/poster.webp
<source-parent>/.previews/<hash>/manifest.json
```

The `.previews/<hash>/` level is mandatory. Do not flatten the files.

Use `uconv` or another verified ICU tool for NFC normalization and `sha256sum` for hashing. If additional container packages such as `jq`, `poppler-utils`, or ICU utilities are required, add them through the container configuration/startup process—not through unsupported TrueNAS host commands.

## Artifact limits

- `thumb.webp`: cropped to 520 × 340, maximum 102,400 bytes.
- `poster.webp`: cropped to 520 × 340, maximum 102,400 bytes.
- `preview.webp`: preserve aspect ratio and contain within 2400 × 1800, target about 450 KiB, absolute maximum 512,000 bytes.
- Every derivative must be a valid WebP.
- Record the actual output width, height, and byte count after generation.
- Use a bounded quality/retry loop that lowers quality and, if necessary, dimensions until the hard byte limit is satisfied.
- If an artifact cannot satisfy its hard limit, do not publish a partial artifact set; log an error and leave the previous valid set intact.
- Respect image orientation metadata.
- For animated images, use a representative first frame.
- For PDFs, render the first page only, then generate both `thumb.webp` and `preview.webp`.
- For videos, choose a representative frame after the opening black frames where practical, then generate `poster.webp`. Do not generate a video proxy for this preview contract.

## Manifest contract

Write valid UTF-8 JSON smaller than 65,536 bytes. Do not construct unsafe JSON through unescaped shell interpolation; use `jq` or another reliable JSON encoder available inside the container.

Image/PDF example:

```json
{
  "sourceKey": "Jobs/Clients/Acme/Edited/IMG_0042.JPG",
  "sourceEtag": "pending",
  "sourceSize": 209715200,
  "producerVersion": "ltds-preview/2.0.0",
  "createdAt": "2026-07-27T12:00:00Z",
  "finalizationStatus": "pending-r2",
  "derivatives": {
    "thumb": {
      "key": "Jobs/Clients/Acme/Edited/.previews/<hash>/thumb.webp",
      "mime": "image/webp",
      "width": 520,
      "height": 340,
      "bytes": 98304
    },
    "preview": {
      "key": "Jobs/Clients/Acme/Edited/.previews/<hash>/preview.webp",
      "mime": "image/webp",
      "width": 2400,
      "height": 1600,
      "bytes": 460800
    }
  }
}
```

Video example:

```json
{
  "sourceKey": "Jobs/Clients/Acme/Edited/video.mp4",
  "sourceEtag": "pending",
  "sourceSize": 2147483648,
  "producerVersion": "ltds-preview/2.0.0",
  "createdAt": "2026-07-27T12:00:00Z",
  "finalizationStatus": "pending-r2",
  "derivatives": {
    "poster": {
      "key": "Jobs/Clients/Acme/Edited/.previews/<hash>/poster.webp",
      "mime": "image/webp",
      "width": 520,
      "height": 340,
      "bytes": 92160
    }
  }
}
```

Requirements:

- `sourceKey` must exactly match the case-sensitive R2-relative path.
- `sourceEtag` must be the literal string `pending`.
- `sourceSize` must exactly equal the current source byte size.
- `createdAt` must be a valid UTC ISO-8601 timestamp.
- Derivative keys must exactly match the deterministic paths above.
- Derivative `bytes` must exactly match the final file size.
- Derivative MIME must be `image/webp`.
- Width and height must be positive integers.
- You may include `sourceSha256` and source modification time for local regeneration decisions, but the current Worker does not validate those fields.

## Safe generation and regeneration

- Generate into a temporary sibling directory, never directly into the live artifact directory.
- Capture source size and modification time before processing and verify both again before publishing.
- Publish a complete artifact set atomically.
- Write `manifest.json` only after all required derivatives have passed validation.
- Keep the previous valid artifact set until the replacement is completely ready.
- Regenerate when the source filename, size, modification time, or content fingerprint changes.
- Use per-source locks with stale-lock recovery so overlapping 15-minute cycles cannot process the same source simultaneously.
- Put temporary and lock paths somewhere excluded from TrueNAS Cloud Sync.
- Bound FFmpeg threads, CPU priority, memory exposure, and per-file execution time so a corrupt or hostile file cannot monopolize the server.
- Use FFmpeg protocol whitelisting/local-file-only behavior where available. Never allow network URLs or playlist references from media input.
- Do not run the container as root if the existing dataset permissions permit a dedicated UID/GID.

## Pruning

- Remove an artifact directory when its manifest points to a source that no longer exists locally.
- Never delete artifacts merely because a scan failed, a mount is unavailable, or the source root is empty.
- Add a circuit breaker: pruning may run only after a successful complete scan of the expected `/data/jobs/Clients` mount.
- Restrict every deletion to a verified `.previews/<64-lowercase-hex>/` path beneath `/data/jobs/Clients`.
- Log how many artifacts were retained, regenerated, skipped, failed, and pruned.

## Tests you must run

Build a disposable fixture tree and test at least:

- Spaces, apostrophes, ampersands, commas, Unicode, and composed/decomposed Unicode filenames.
- Upper- and lowercase extensions.
- A 100+ MB image.
- A multi-gigabyte-style video test or representative large sparse fixture where practical.
- A multipage PDF.
- Corrupt image, video, and PDF inputs.
- Exact `Dump`, `.previews`, and `_ltds` exclusions at multiple nesting levels.
- Source changes during generation.
- Two concurrent script invocations.
- Stale lock recovery.
- Regeneration after size or modification-time changes.
- Pruning after a successful scan.
- No pruning when the source mount is unavailable or a scan fails.
- Exact SHA-256/NFC filename mapping.
- Exact JSON escaping.
- Every artifact’s real MIME, dimensions, and byte limits.
- Idempotency: a second unchanged run generates nothing.

## Deliverables

1. The complete final `preview-gen.sh`, not a partial patch.
2. Any complete `docker-compose.yml` or container-startup changes required.
3. A short explanation of dependencies and why each is needed.
4. The exact TrueNAS-safe steps to deploy and restart it.
5. Test scripts/fixtures and the captured test results.
6. A dry-run mode and clear operational logs.
7. A final checklist confirming every Worker contract item above.

Do not silently relax a contract. If the current TrueNAS/container setup conflicts with one of these requirements, stop and explain the conflict and the safest adjustment.
