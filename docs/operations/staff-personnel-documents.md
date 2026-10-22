# Private personnel documents — review draft

This slice is source-only and default-off. It provisions no employee, grant,
bucket, scanner, public link, PA record or deployment. Employee profiles remain
owned by Operations independently of PA employees. Claude owns the UI integration.

## Storage and activation boundary

Migration `0225_staff_personnel_documents.sql` adds five explicit native staff
management capabilities without granting them to existing identities. The private
personnel candidate view requires a current native admission and an explicit
global or exact-staff allow; matching denies across every supported scope win.
No employee can read their own documents merely because they are the target.
Ordinary staff roles, PA roles, client membership and file-root grants do not
grant personnel access. Existing native delegation ceilings still govern future
delegation management; this change does not create delegation or recovery routes.

Activation requires all of the following, separately reviewed:

- Apply migration 0225 after the existing Operations migrations.
- Bind `STAFF_DOCUMENTS_BUCKET` to a **new, private personnel-only R2 bucket**.
  Never bind `client-data`, `DATA_BUCKET`, incoming, or any employee delivery root.
  Do not configure public domains, public access, notifications that index its
  contents, client service bindings, replication into delivery buckets, or
  object-expiration lifecycle rules. No bucket is created by this patch.
- Configure a dedicated `STAFF_DOCUMENTS_SCANNER_TOKEN` secret of 32–512 characters.
- Operate and qualify a trusted scanner for the supported types, including Office
  container/type validation and active/macro content policy. The scanner must read
  the exact quarantined version, calculate its SHA-256, and submit its actual verdict.
  Setting a scanner token **does not install or qualify a scanner**.
- Review the personnel capabilities for the administrator and exact target scope.
- Enable `STAFF_PERSONNEL_ENABLED=true` only after authenticated staging tests.

`OPERATIONS_SESSION_SECRET` supplies a separate domain-separated CSRF token.
No new environment file, default grant, public delivery credential or PA key is
required. The personnel bucket is not exposed through MCP, Windows catalogs,
employee file gateways, general R2 browsing or client delivery APIs.

## Human HTTP contract

Every request requires the existing staff Access assertion and
`X-Personnel-Request: 1`. The URL origin must equal configured `PUBLIC_BASE_URL`.
Every mutation also requires that exact `Origin` and the `X-CSRF-Token` returned
by the session endpoint. Tokens bind actor, verified subject, admission version,
origin and Access audience, and accept the current/prior ten-minute bucket.
Native admission and current target authority are rechecked before storage and
again before private content is returned. Downloads therefore use an authenticated
fetch followed by a browser download, rather than a bearer URL.

Base: `/api/staff-personnel/profiles/:staffId`.

| Method/path | Contract |
| --- | --- |
| GET `/session` | Returns `csrfToken`, `verifiedUntil`, permitted personnel `capabilities`; requires `staff.documents.read`. |
| GET base or `/documents` | Returns lifecycle `{archived_at,version}` and up to 100 documents with retention review metadata. |
| POST `/documents` | Raw bytes; headers `Idempotency-Key` UUID, `X-File-Name` exactly `encodeURIComponent(NFC filename)`, `X-Document-Category`, `Content-Type`. Requires `staff.documents.upload`. |
| GET/HEAD `/documents/:id/content` | Requires `staff.documents.read`; accepted scan only; attachment, private/no-store/nosniff; no public links. |
| POST `/documents/:id/retention` | `{commandId,expectedVersion,hold,reviewAfter:null|YYYY-MM-DD,reviewNote}`; nonempty review note, explicit `staff.documents.manage`. |
| POST `/archive` or `/restore` | `{commandId,expectedVersion,reason}`; explicit `staff.profile.archive` or `staff.profile.restore`. |

Document DTO fields: `id,staffId,filename,category,contentType,size,status,createdAt`.
Lists additionally include `retention:{hold,reviewAfter,reviewNote,version}`.
Internal keys, object ETags and hashes never appear in human DTOs or audit payloads.
Categories: `agreement`, `tax`, `onboarding`, `other`.

Admitted types: PDF, JPEG, PNG, DOCX, XLSX and UTF-8 TXT. Extensions and declared
MIME must match their initial signatures. HTML, SVG, executables, legacy DOC/XLS,
macro-enabled Office extensions and arbitrary archives are unsupported.
The ZIP magic check for DOCX/XLSX does **not** establish a valid or safe Office
document. All admitted files stay quarantined until the trusted scanner accepts
them. No inline document rendering, macro execution or structural-validation-as-AV
claim is introduced.

Each upload is bounded to 25 MiB by actual streamed bytes independently of
Content-Length. A profile has at most 100 retained uploads and 512 MiB total,
including failed/incomplete uploads. Original bytes are write-once at opaque UUID
keys. Retries with the same actor/command and exact target/metadata/bytes recover
the existing upload; changed payloads conflict. Existing accepted bytes are never
overwritten. Interrupted uploads retain a durable reservation; retry the original
request. Automated cleanup/purge and administrative orphan recovery are deliberately
not implemented, so unrecoverable reservations require a reviewed operator process.

## Scanner boundary

`GET /api/staff-personnel/scanner/:documentId/content` and
`POST /api/staff-personnel/scanner/:documentId/receipt` require only the dedicated
scanner bearer credential, never a human personnel grant. They cannot enumerate
documents. The scanner GET returns quarantined exact-version bytes and
`X-Document-SHA256`, `X-Document-ETag`, `X-Document-Content-Type`, and an encoded
`X-Document-Filename`. Receipt JSON is exactly
`{sha256,etag,verdict:"clean"|"rejected"}`. Server metadata must match the stored
object version/size/hash. Contradictory or mismatched receipts fail closed;
repeating the identical terminal verdict is idempotent. The scanner's SHA must
come from its own byte digest, not from copying the expected response header.

Only accepted objects can be downloaded. Reads pin the accepted ETag, expected
size and stored integrity metadata. A changed/missing object fails closed.
Scanner receipts and uploads/downloads are audited without recording document
contents, object keys or hashes in ordinary event details.

## Archive, holds and retention

Employee archive and admission disable execute in one SQL event transaction.
The transaction must preserve a complete active native control-plane administrator.
Self-archive is denied. Archived staff cannot be admitted, receive new uploads,
or regain permissions from a profile restore. Explicit restore only removes the
archive marker; separately reviewed admission enabling remains necessary.
Authorized administrators can still retrieve retained records for archived staff.

There is no ordinary delete endpoint or automatic expiration. SQL prevents
deletion of personnel documents, profiles, audit records and retention metadata.
New document bytes are additions rather than overwrites. Hold/review changes use
optimistic versions, idempotent command IDs, current authority and durable audit.
`reviewAfter` is a date for a human retention review, **not** a deletion eligibility
date. A null date does not mean no legal retention obligation.

Retention periods depend on document category, employment/tax events, applicable
rules, disputes and holds. This implementation does not invent a universal
seven-year or indefinite legal requirement, calculate binding legal dates, or
automatically purge personnel information. A later reviewed retention/disposition
process is necessary before any exceptional destruction path can exist.

## Verification scope

`apps/operations/test/staff-personnel-http.test.ts` uses synthetic identities,
real local Miniflare D1 and a private local R2 bucket. The authentication seam
provides a synthetic previously verified native actor; signed Access JWT validation
remains covered by the existing native staff authentication suites. These tests
do not prove a deployed scanner, production bucket isolation, a live upload,
legal retention compliance, or UI accessibility. No real personnel data is used.
