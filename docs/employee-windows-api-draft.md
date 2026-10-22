# Employee Windows API draft (unmounted)

One fixed protected Ops HTTPS origin, current human native staff Access audience,
no machine identity or implicit role-based file access. The existing private
gateway protocol stays behind Ops. Register/grant administration is separate;
clients cannot provision permissions through read endpoints. UI remains Claude's.

## Read routes for the Windows adapter

GET `/api/staff/files/roots` returns exact
`{schemaVersion:1,roots:[{rootId,gatewayId,displayName}]}` (at most100). Root/gateway
IDs are canonical RFC UUIDs. displayName is an operator-defined1..160 label.
Only explicit current native exact-root read grants are discoverable.

GET `/api/staff/files/roots/:rootId/entries?path=<encoded-relative-path>&cursor=<optional-opaque>`
returns exact `{schemaVersion:1,entries:[{name,kind}],nextCursor}` as the private
paged gateway contract. path is required (empty for root); decode exactly once.
Reject duplicate/unknown query keys, traversal, malformed/oversized cursors and
noncanonical path components. Max200 entries,256KiB JSON. Names remain Linux
source names; they are not local Windows paths. Cursors select, never authorize.

GET `/api/staff/files/roots/:rootId/manifest?path=<encoded-relative-file-path>`
returns exact `{schemaVersion:1,logicalFileId,remoteVersion,strongETag,size,sha256,name,downloadPath,expiresAt}`.
logicalFileId is `oef1_` plus64 lowercase HMAC-SHA256 hex, purpose-separated over
issuer/audience, staff/subject/admission, exact grant/root-generation/fingerprint
and relative path; exclude expiring snapshot IDs and profile version. remoteVersion
is the64 lowercase content SHA256. strongETag is the quoted SHA256. name is a safe
Windows basename at most150 UTF16 units, sanitized by Ops. expiresAt is Unix
seconds, min(now+900,human/grant expiry,gateway snapshot expiry-30s clock margin).
Unusable/expired preparation returns409. Maximum manifest64KiB.

downloadPath is exactly `/api/staff/files/downloads/<eof1_opaque-AESGCM-handle>`
with URL-safe base64 characters, total handle at most16384. No host path or
backend URL is exposed. Handle binds the Ops origin and Access issuer/audience,
exact employee proof pins, relative path, prepared snapshot ID, SHA/size and
expiry. Use a dedicated Worker-only32+byte key with purpose-derived encryption
and logical-ID subkeys, not a Viewer key or human token. It is not a standalone
authorization credential. Every use authenticates native human staff and
resolves/rechecks the exact current grant/root proof before/after upstream awaits.

GET `/api/staff/files/downloads/:fileHandle` requires exact strong If-Match.
Support a single `bytes=start-end` or `bytes=start-` range; resolve open end from
the pinned total length. Unknown/multiple/noncanonical ranges=>416; wrong ETag
=>412. Forward only a validated private gateway content response, after a durable
content-start audit and fresh exact authority recheck. 401 needs explicit human
login;403 denies access;404/409 requires discovery/manifest renewal. The Windows
adapter must never open a browser automatically or follow a redirect. Its stable
download-state identity is logicalFileId+remoteVersion, not expiring handle/URL.

## Provisioning and audit

Add migration0223: operator root display label, a distinct `employee.files.manage`
permission for global owner/admin roles, and durable actor-attributed mutation
receipts. An administrator role alone never grants file reads. Deny overrides at
any scope block administration. Strict current native human identity, profile and
admission versions, active staff, global owner/admin role and explicit permission
are checked in the same D1 transaction that performs a mutation and its audit.

Implement idempotent reviewed commands: register-root, advance-root (including
disable/remap, optimistic expected generation), grant-read, deny-read and
revoke-grant. Exact target native admission epoch and exact root pins only; no
wildcards, automatic imports or side effects outside Ops. commandId UUID plus
canonical request hash binds replay to actor and payload; changed replay=>409,
same replay cannot revive a revoked grant. Issuer and audit linkage are durable.
Root enrollment accepts only a configured gateway's operator-provided enrollment
fingerprint; it never accepts a host filesystem path. A fabricated fingerprint
cannot expose files because the private gateway requires its actual enrollment.

Expose a source-level Hono administration factory, still unmounted, accepting
bounded JSON POST at `/api/admin/employee-files/commands`. Require exact configured
Ops Origin on mutation plus native staff JWT authentication. A dedicated feature
gate remains off until staging tests, provisioning review and deployment setup.

Record content starts durably with exact actor/grant/root/snapshot/digest/range
pins and a SHA256 of relative path (never JWTs, keys or host paths). Fail closed
if audit fails. Downloads already handed off cannot be recalled. Administrative
and read route factories remain unmounted in the production app in this phase.

### Administrative command shapes

Every body has `commandId` (new UUID) and `kind`. Reject unknown, duplicate or
missing fields; the complete JSON body is bounded to 8 KiB. These are backend
contracts for a reviewed operator UI, not commands that a client desktop app
may issue.

| kind | Additional fields |
| --- | --- |
| register-root | rootId, gatewayId, rootFingerprint, displayName |
| advance-root | rootId, expectedGeneration, rootFingerprint, displayName, status (`active` or `disabled`) |
| grant-read / deny-read | rootId, rootGeneration, rootFingerprint, grantId, targetStaffId, targetAccessSubject, targetAdmissionVersion, expiresAt (Unix seconds) |
| revoke-grant | grantId, expectedGeneration |

Changing a root increments its generation and invalidates earlier grants, even
when only the label changes. Re-grant intentionally against the new enrollment;
do not silently carry old access across a remap. Revocation is terminal for a
grant ID. To restore access, review and create a new grant ID and command ID.
An exact active deny wins over an allow. Neither a management permission nor a
successful root registration creates a file-read grant for the administrator.

The receipt is exactly
`{schemaVersion:1,commandId,kind,rootId,grantId,generation}`. It acknowledges the
recorded command; replaying an old receipt does not assert that its grant is
still active. Read discovery always evaluates current authority separately.
