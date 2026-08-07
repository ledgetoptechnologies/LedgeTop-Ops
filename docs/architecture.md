# Architecture and security boundaries

## Request boundaries

```text
Cloudflare Access
      |
      v
ops.ledgetopdroneservices.com
      |-- OPS_DB: staff, ACL, projects, operations, tasks, FAA, audit
      |-- DELIVERY_DB: grants, notification/thumbnail jobs, file index
      |-- private R2: staff browsing, originals, private brief attachments
      `-- file-event/thumbnail Queues, Images transforms, Stream management

delivery.ledgetopdroneservices.com
      |-- DELIVERY_DB only
      |-- private R2, authorization-confined original/thumbnail serving
      |-- public-share and authenticated client-workspace sessions
      `-- Stream signed playback only
```

Delivery never receives an `OPS_DB` binding. R2 has no public bucket domain. Both Workers stream object bodies and HTTP byte ranges rather than buffering media.

Operations state changes deny non-administrators by default and also require the
matching D1 permission. A path-exact allowlist permits only narrow delegated
routes, including delivery-link and internal-folder grant creation/revocation,
Stream tickets, incoming-link administration, Dropbox import, and operational
job-brief save/attachment actions, to bypass the global administrator gate.
Those routes still require the existing human session, same-origin/CSRF checks,
and their route-specific scoped permission; the allowlist is not an R2 or ACL
bypass. Project Alpha controls which identities may sign in; local D1 roles
control what those identities may do after authentication. Delivery
Coordinators can browse and manage links without receiving R2 mutation
permissions.

Large authenticated staff uploads use same-origin, Worker-mediated multipart
transfer into private R2 staging. The Worker validates the complete upload
intent and every destination, checkpoints parts in D1, and never accepts a
caller-supplied unrestricted R2 key or returns a public/presigned R2 URL.
Recursive copy, move, rename, replacement, and purge work is represented by
durable operation records and processed in bounded, idempotent steps. Folder
copy, move, and rename requests are rejected when the destination is the source
itself or any descendant of the source, and the job processor repeats that
validation before touching R2.

Staff can also import files from Dropbox via a separate OAuth PKCE flow on the Operations Worker. The import Workflow enumerates the selected Dropbox folder, downloads files in 8 MiB chunks, and uploads to R2 via multipart upload. Import credentials are AES-GCM encrypted with per-authorization binding and support refresh-token rotation. The import is gated by the `delivery.files.upload` permission and does not require administrator access. See [cloud transfers](cloud-transfer.md) for configuration.

## Staff authentication and ACL

Cloudflare Access authenticates people; it does not grant LTDS permissions. The Ops Worker verifies the Access JWT signature, issuer, expiry, exact Operations audience, `RS256`, `type=app`, nonempty human subject, and email. The email must match an active provisioned account. On first successful login, that account binds to the Access subject and rejects future subject mismatches.

The default-off client portal has a separate Access trust domain: a dedicated
client application audience and client-managed group authenticate `/portal*`
and `/api/client*`, after which D1 account, project, delivery, team, request,
and billing grants authorize each operation. Staff ACLs and client-team ACLs
are independent. A staff identity, a historic Delivery token, an Access group
membership, or a Project Alpha payment/billing record alone grants no client
permission.

Public shares remain a separate capability boundary on the same future client
origin. `/s/*` and `/api/public/*` bypass Access and enforce their existing
opaque link, revocation, expiry, password, session, share-version, and object
checks. Portal delivery handoff rechecks a local grant and redirects into that
flow; it does not mint or substitute a public-share session.

ACL order:

1. Missing, inactive, unprovisioned, or subject-mismatched staff are denied.
2. Resource division, owner, and assignment context is derived server-side.
3. Applicable explicit user denies override all grants.
4. Explicit user allows and role grants are evaluated by scope.
5. Missing permission denies by default.
6. Module denials return `403`; inaccessible cross-division objects return `404`.
7. Lists apply SQL scope predicates before pagination.

The Owner role is represented by immutable seeded grants; code has no role-name bypass. The API prevents deactivation of the final active global Owner.

## Project Alpha and LTDS ownership

Project Alpha remains generic and strictly read-only from LTDS. It owns client,
organization, project, operation, status, schedule, assignment, and entitlement
identity. LTDS stores a last-known-good projection and never creates or edits
Project Alpha records or financial artifacts. Signed incremental events and
complete snapshots update only LTDS-local projection and authorization state.

LTDS owns direct client-workspace folder grants, their revocation-safe
notification outbox, operational execution briefs, private brief attachments,
and audit history. An internal folder grant is accepted only when Operations
derives one unambiguous active Project Alpha client/organization owner and
division from the longest matching project-folder association; the caller
cannot select that authority context. A job brief may reference only an active
projected operation, and pilot visibility follows the operation's current
projected assignment.

Client-workspace list and content routes return opaque same-origin file
identifiers. Before the first R2 read, the Client Worker rechecks the Access
session, active identity/account/membership, current folder or project grant,
and exact indexed key. Brief attachment routes likewise reauthorize the
operation and attachment before R2. Neither path returns an R2 key, presigned
bearer URL, or credential to the browser.

## Client link security

New URLs have the form:

```text
https://delivery.ledgetopdroneservices.com/s/<public-id>#<32-byte-secret>
```

The fragment is never transmitted in an HTTP request. The browser posts it once, receives a signed `__Host-ltds_delivery` `HttpOnly; Secure; SameSite=Lax; Path=/` cookie, and removes the fragment from browser history. D1 stores only SHA-256 of the secret. Legacy `/s/<secret>` links are upgraded on redemption and remain compatible.

Optional access codes are PBKDF2-derived with a random salt, application pepper, bounded iteration count, and rate limiting by share/client and client across shares. A session cannot outlive its share. Every manifest, preview, and download rechecks revocation and expiration.

R2 paths use opaque base64url item references. Validation rejects traversal, backslashes, controls, absolute paths, exact case-insensitive `dump` components, nested `.previews` artifacts, and the reserved `_ltds` root. Unsafe formats such as HTML, XML, JavaScript, and SVG are downloads rather than inline content.

Folder grids use one current Cloudflare Queue-generated thumbnail and never
request originals as thumbnail fallbacks. Supported still images are normalized
through Cloudflare Images. Eligible private MP4/H.264 videos use Cloudflare
Media Transformations to extract one frame at five seconds, then the same Images
normalization path. Pending, unsupported, oversized, and failed media use a
client-bundled file-kind icon; PDF, text, archive, office-document, and unknown
items remain icon-only. Clicking an eligible item is the only action that opens
its authorized full-resolution original with range support. Cards and filmstrips
never preload the original, and no medium preview or video transcode is created.
See [Cloudflare thumbnail-only media delivery](media-thumbnail-pipeline.md).

## Airspace safety model

TFRs and special-use airspace are deliberately separate:

- TFRs can restrict or prohibit operations.
- MOAs are nonregulatory but may contain hazardous military activity.
- Restricted/prohibited areas retain their regulatory type.
- A missing SUA reservation is `not_listed`, never inactive or clear.

FAA data is checked every two hours and is stale after three hours without a complete successful refresh. Stable source and record fingerprints prevent unchanged snapshots from rewriting D1; only changed or missing records are reconciled. Failed parses retain the last known snapshot. Expired/withdrawn TFR and expired SUA reservation rows are purged after 24 hours; stable SUA geometry remains for future matching. The UI never displays “clear to fly.”
