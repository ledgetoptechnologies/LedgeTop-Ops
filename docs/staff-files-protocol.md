# Staff Files write protocol v2 (Ops to NAS container)

**Status: draft; staging only.**

- **The container** is `apps/employee-read-gateway/employee_read_gateway/staff_files`, published as the image `ledgetop-staff-files`.
- **Ops write routes:** a later slice. This slice adds only the read-only staff policy at `GET /api/staff/files/policy`.
- **Design:** revision 4, reviewed by Codex.

## Trust

Every `POST /v2/op` must pass two independent checks:

1. **The NAS link Access assertion** (`Cf-Access-Jwt-Assertion`), verified at the origin.
   - Algorithm RS256 only, from the fixed team issuer.
   - The audience must be exactly `NAS_LINK_AUDIENCE`.
   - The claims must be `type='app'`, `sub` present and the empty string, no `email`, and `common_name` equal to `NAS_LINK_CLIENT_ID`.
   - Keys are fetched only from `<issuer>/cdn-cgi/access/certs`: at most one refresh per 5 minutes, a refresh every 12 hours, and fail closed after 7 days without one.
   - Any failure returns 404.
2. **An Ops Ed25519 signature** on the envelope.
   - **Signing input:** Ops serializes the envelope once as UTF-8 JSON and signs `b"ltfiles-v2\n"` (ASCII, one LF) followed by those exact bytes. Nothing is canonicalized or re-serialized.
   - **Headers:**
     - `X-Ltfiles-Envelope`: unpadded base64url of the envelope bytes, at most 8 KiB decoded;
     - `X-Ltfiles-Signature`: unpadded base64url of the 64 signature bytes.
   - The container verifies before parsing. The JSON must then have unique keys and no floats.

**Freshness.** `expiresAt` is checked when the signature is verified, again after the body has been read, and again immediately before every irreversible change: a write, a rename, a mkdir, or recording an intent. The replay store refuses an already-expired entry.

**Coordination.** One process owns a root: an exclusive flock on `.ltfiles/state/owner.lock`, which a second instance cannot take. Every mutation runs under one root-wide write lock. The folder handles used for a change must still be the objects that were checked.

**Keys.**
- The public keys are in `OPS_FILES_SIGNING_PUBLIC_KEYS`, in the shared `nas-link.env`, as `scope:keyId:base64url32`.
- `files-write` keys only authorize writes; `files-read` keys never do.
- At most two keys per scope, for a rotation overlap.
- The private keys exist only in Ops.

## Envelope

Exact keys; unknown or missing keys are refused:

- `schemaVersion` (2), `scope` (`files-write`), `keyId`, `nonce` (32 hex characters, single use), `issuedAt`, `expiresAt` (30 seconds or less);
- `audience` and `servicePrincipal`, which must equal the verified link values;
- `method` `POST`, `route` `/v2/op`;
- `operationId`: a UUID, stable across retries of one change;
- `actor` `{staffId, accessSubject, admissionVersion}`;
- `grant` `{grantId, grantGeneration, path, rights}`. Writes need `rights=["read","write"]`, and every affected path must be strictly inside `path`;
- `root` `{rootId, rootGeneration, rootFingerprint, exclusive:true}`. Shared roots are read-only;
- `operation` and `args`, with exact keys per operation;
- `bodySha256`: the SHA-256 of the request body (empty unless the operation is `upload.chunk`).

## Operations

| operation | args | notes |
|---|---|---|
| `mkdir` | `path, parentId` | 409 if a case-folded sibling exists |
| `upload.begin` | `path, parentId, size, sha256, precondition` | `{"kind":"create"}` only. **Overwrite is disabled in v1** (400 `overwrite-unsupported`). Reserves quota. |
| `upload.chunk` | `index, chunkSha256, chunkSize` | body = chunk; fixed chunk size (32 MiB), except the last; re-sending the same chunk is harmless |
| `upload.status` | none | which chunks are received, and the lease |
| `upload.commit` | none | The SHA-256 is verified and cached; a long hash that outlives the signature returns 401 and publishes nothing. A freshly signed retry reuses the cached hash. Then an atomic create-only `RENAME_NOREPLACE`. |
| `move` | `source, sourceId, sourceEtag, destination, destinationParentId` | locks both parents; no move into its own subtree |
| `delete` | `path, id, etag` | moves the item to `.ltfiles/trash/<operationId>/` |
| `trash.restore` | `trashId` | back to the original path; 409 if that name is taken |
| `op.status` | `targetOperationId` | The typed state of the caller's own operation. It needs the same staff, grant and current grant generation, and every path in the operation must be inside the current grant folder (404 otherwise). |

**Identity.**
- An `id` is opaque: device, inode and birth time (from `statx`).
- An `etag` is the SHA-256 of the content.
- Files need both; folders need the `id` only.

**Results.**
- Each operation's result is stored. An identical retry with the same `operationId` returns it.
- The same `operationId` with different intent returns 409.

**Recovery.**
- An `intent` row and an audit row are written, with `synchronous=FULL`, before any change.
- Every outcome, normal or recovered, goes through one transition that also applies its upload and trash effects.
- On restart, unfinished rows are settled from filesystem evidence. Where the evidence cannot decide, the row becomes `unknown`, and all writes return 423 until `resolve-hold`. Nothing is replayed.
- `resolve-hold` also needs evidence. A decisive result must agree with it. Otherwise only `rejected` is accepted, and only when the object is not at its destination.

**Limits.**
- File size: 50 GiB at most.
- Quota per grant: 64 GiB. Global quota: 256 GiB. Free space must stay above a 10 GiB margin.
- Open uploads: 8 per person, 64 in total.
- The upload lease is 15 minutes, renewed by each chunk, with a 24-hour maximum.
- Purge is off: expired uploads and trash keep their bytes, and still count against quota.

**Layout.**
- `/data/root` is served.
- `/data/.ltfiles` sits beside it on the same filesystem, private (mode 0700) and owned by the container user. The container refuses to start otherwise.
- Symlinks, special files, hard-linked files and mount crossings are refused.
