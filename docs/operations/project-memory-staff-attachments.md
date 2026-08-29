# Project Memory staff attachments

Status: implemented and verified locally on August 28, 2026. Migration `0047`
must be applied before the Worker containing these routes receives traffic.
This increment is intentionally staff-only and does not add client upload,
copy-forward, deletion, notification, or `project_file` reference behavior.

## Authority and routes

The routes use the existing exact business-project base:

`/api/client-hub/sources/:sourceId/business/:kind/:publicId/business-projects/:projectId`

- `POST /operational-memory/attachments/upload`
- `GET|HEAD /operational-memory/attachments/:attachmentId/content`

Reads use the same current source-qualified project visibility and root checks
as Project Memory. Uploads additionally require an Operations administrator
with effective global `project.memory.manage`; manager/project assignment alone
does not grant upload authority. The Worker resolves authority before consuming
the body and rechecks it after the R2 write and at final commit. Content delivery
authorizes before attachment lookup or R2 access, then repeats the row/root and
authority checks after R2 metadata I/O and immediately before a GET.

The upload is a raw body with these headers:

- `Content-Type`
- `X-Expected-Context-Version`
- `X-Expected-Version`
- `X-Idempotency-Key`
- `X-File-Name`, exactly once percent-encoded from UTF-8 with
  `encodeURIComponent`
- `X-Amendment-Reason` only for completed or cancelled projects

The server strictly decodes the filename once, normalizes NFC, retains only the
leaf name, and rejects controls, Unicode bidi/invisible formatting, malformed or
non-canonical encoding, and excessive character/UTF-8 length. This avoids the
browser `ByteString` limitation on non-Latin filenames and prevents ambiguous
double decoding.

## Storage and integrity

Each accepted upload is at most 25 MiB. Project Memory is limited atomically to
100 committed attachments and 512 MiB. In-flight work also has bounded project
and actor count/byte budgets so crashed requests cannot create an unbounded R2
staging pool.

Supported types are JPEG, PNG, WebP, GIF, TIFF, and PDF with matching filename
extension, declared type, and recognized structural signature. SVG, HTML,
truncated signature-only images, obvious active PDF declarations, encrypted
PDFs, and type mismatches are rejected. This is structural validation, not
malware scanning. Content is always returned as an attachment with
`Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.

R2 keys are opaque and write-once:

`_ltds/ProjectMemory/<random UUID>/content`

The display filename exists only in D1. R2 metadata pins the attachment ID,
byte size, SHA-256, and raw ETag. Reads verify the D1 and R2 values before any
body is released. The raw ETag is used for R2 preconditions; the quoted
`httpEtag` is used only in the HTTP response. HEAD and single byte ranges are
supported. A metadata-only R2 result from a failed precondition is a conflict,
never an empty successful response.

Public attachment DTOs contain only ID, display name, accepted content type,
size, `staff_upload` source kind, memory version, creation time, and the scoped
download path. Object keys, ETags, hashes, intent state, and source storage
references are never returned or written to public event/receipt JSON.

## Atomic commit and recovery

Migration `0047` adds attachment metadata, attachment-specific append-only
events, actor-bound mutation receipts, upload intents, and attachment write
fences. The final D1 batch advances the Project Memory version and immutable
revision, inserts the attachment and event, stores the receipt, completes the
intent, and exhausts both fences. Triggers bind every immutable attachment field
to the exact object-written intent and exact source/project/root/version fence.
Counter transitions cannot be skipped, reordered, reset, or completed without
their corresponding durable row.

The same idempotency key with the same bytes and target returns the committed
public result. A changed fingerprint returns conflict. Concurrent attempts can
produce only one attachment and receipt.

An uncertain or precommit failure never directly deletes a possibly committed
object. It moves the intent to durable cleanup. Scheduled maintenance:

1. ages abandoned `prepared` and `object_written` intents after a one-hour grace;
2. claims a bounded cleanup batch;
3. rechecks for an attachment reference;
4. deletes only an exact key/ETag/size/hash/attachment-ID match;
5. retries bounded failures and marks ownership mismatches for manual review;
6. prunes old completed cleanup metadata without touching committed objects.

Cleanup logs contain aggregate counts only, not filenames, object keys, hashes,
or customer/project identifiers.

## Verification and rollout

Focused evidence is in:

- `apps/operations/test/project-operational-memory.test.ts`
- `apps/operations/test/project-operational-routes.test.ts`
- `apps/operations/test/browser/business-project-workspace.spec.ts`

The tests cover populated migration application, exact-source/root fences,
idempotent replay/conflict, Unicode names, hostile/mismatched/oversized input,
pending and committed quotas, ambiguous commit cleanup, committed-object
preservation, R2 metadata/precondition behavior, HEAD/range delivery, wrong-scope
denial before R2, administrator gating, and refresh-safe UI behavior.

Rollout order is migration, Worker deployment, then an authorized upload/HEAD/
range smoke test. If rollback is needed, stop attachment upload traffic first;
do not remove `0047` tables or R2 objects while any committed attachment rows
remain.
