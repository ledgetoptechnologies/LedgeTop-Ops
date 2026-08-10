# Retired `.previews` pipeline — current thumbnail pointers

The former TrueNAS `.previews` producer is retired. Do not run its FFmpeg cron
or container and do not generate `.previews/*/preview.webp`, `poster.webp`, or
legacy `manifest.json` artifacts. Legacy objects may remain during a rollback
window; do not delete them without a separately reviewed cleanup plan.

The active implementation creates one private `320x240` WebP only:

| Source | Current behavior |
| --- | --- |
| Still image | libvips thumbnail, within documented byte/pixel caps |
| PDF | Poppler first-page thumbnail, within documented caps |
| Video | Type-specific icon only; no frame extraction, preview, or transcode |
| Office, text, archive, audio, other | Type-specific icon only |

Server pre-generation uses the version-bound `prebuilt/` namespace; the private
Cloudflare Container fallback uses the separate `managed/` namespace. Neither
path creates a public R2 URL or permits an original-file thumbnail fallback.

Use the current [private thumbnail runbook](../media-thumbnail-pipeline.md) for
the authoritative contract and the [TrueNAS synchronization and Custom App
runbook](README.md) for deployment. The historical files in this directory are
compatibility evidence only and are not accepted by the current registration
endpoint.
