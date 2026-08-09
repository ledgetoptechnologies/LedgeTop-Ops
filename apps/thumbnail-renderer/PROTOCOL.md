# Private TrueNAS prebuilt registration protocol

The decoder creates a persistent immutable WebP and a private receipt. After
the synced WebP has an R2 ETag, the broker creates the final sibling JSON beneath
the local `prebuilt/` cache. A dedicated TrueNAS UI sync maps only that local subtree
to `_ltds/derivatives/thumbnails/v1/prebuilt/` in the private R2 bucket. It must
never target the parent derivatives namespace or the Cloudflare-only `managed/`
subtree.

The final manifest is schema version 1 and contains provider `ltds-truenas`,
profile `ltds-thumbnail-320x240-webp-v1`, canonical `sourceKey`, exact clean R2
`sourceEtag`, source size/MIME, `sourceFingerprint` as
`{"algorithm":"sha256","value":"<lowercase source SHA-256>"}`, renderer version, creation time, and
the WebP key/ETag/MIME/320x240 dimensions/bytes/SHA-256. The source uploader must
store a full-object SHA-256 checksum with the R2 object. The broker requests that
checksum on both stable source HEADs and requires it to equal the decoder's
full-file SHA-256 before writing the manifest. Operations independently requires
the same R2 checksum before registration. A missing/composite/mismatched checksum
fails closed; the prebuilt is not registered and the managed fallback remains
authoritative. Size, timestamps, or an ETag alone are never treated as content
equality proof. Cloudflare's current S3 compatibility exposes SHA-256 as a
composite, not full-object, checksum for multipart uploads and does not document
`x-amz-checksum-mode` for `HeadObject`; the broker therefore does not send that
unsupported header or reinterpret a multipart ETag as a full-file digest.

After rclone uploads the final manifest, the broker posts less than 8 KiB to the
exact HTTPS path `/api/internal/thumbnail-ingest/v1`:

```json
{
  "schemaVersion": 1,
  "provider": "ltds-truenas",
  "manifestKey": "_ltds/derivatives/thumbnails/v1/prebuilt/Jobs/.../<fingerprint>.json",
  "manifestEtag": "exact-clean-r2-etag",
  "thumbnailKey": "_ltds/derivatives/thumbnails/v1/prebuilt/Jobs/.../<fingerprint>.webp",
  "thumbnailEtag": "exact-clean-r2-etag"
}
```

Authentication uses both `Authorization: Bearer <THUMBNAIL_INGEST_SECRET>` and
the Cloudflare Access service-token headers `CF-Access-Client-Id` and
`CF-Access-Client-Secret`. The endpoint is not reachable through a public
application session alone.
Operations re-reads the exact manifest and WebP, validates actual WebP chunks,
dimensions, metadata/animation absence, content types, ETags, source index,
live R2 source version, limits, and tombstone/trash state before mapping it.

Success is `200`. `401` is a fatal secret error; `400`/`413`/`415`/`421` are
permanent configuration/content errors; `409`, `429`, and `5xx` retry with local
bounded backoff. A permanent source-checksum proof failure leaves the receipt
failed so Operations can use managed fallback. Responses and logs must not echo
source keys.
