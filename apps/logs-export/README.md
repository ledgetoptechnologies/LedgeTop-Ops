# Temporary raw telemetry export

This is a one-off, read-only Worker. It lets the NAS copy receive the **original stored bytes** of each Logs telemetry
track. A normal client or connector can silently decompress `.json.gz` objects, and that copy would not be the
original. Delete the Worker once the copy is verified.

- It serves only `GET /telemetry/v1/<uuid>.json.gz`, on `EXPORT_HOST`, to one Access service identity.
  `EXPORT_CLIENT_ID` is checked at the origin with the reviewed verifier from `apps/logs-local/src/access-jwt.mjs`:
  exact issuer, audience and client id. Anything else gets 404 before the bucket is read. An incomplete configuration
  gets 503.
- The body is streamed unchanged as `application/octet-stream`, **never with `Content-Encoding`**, with
  `Cache-Control: no-store, no-transform`.
- Response headers `X-Source-Size` and `X-Source-Etag` (an MD5 for single-part objects) let the receiver prove the
  bytes are the originals. `X-Source-Content-Encoding` is informational only.
- No listing, no other keys, no D1, no writes, no secrets.
- **Staging only.** The template names the Staging account and the Staging Access issuer explicitly.
- The R2 binding is scoped to one bucket, but the binding API can write. "Read-only" is this Worker's reviewed code
  behaviour (only `get()` on exact keys), not an R2 permission.

The receiver must read the body without automatic decompression, for example `node:https.request`, or Python
`requests` with `raw.read(decode_content=False)`. It then lists each object in the snapshot's `objects.jsonl` with
`sourceBytes` and `sourceEtag` (see `apps/logs-local/SNAPSHOT-IMPORT.md`). The importer refuses any file that doesn't
match them.

Tests: `npm test` (Node 24, no dependencies).
