# Windows continuous catalog contract (source only)

The Windows catalog has dedicated endpoints and selectors. Existing browser
catalogs, public shares, `ond1_` routes and the ordinary audit ledger retain their
existing behavior. These new factories are not mounted or deployed by this work.

## Authority and permissions

The existing private Ops reader exposes
`readWindowsCatalogSuccessorAuthorization(canonicalOriginalGrant, feature)`.
Only `folder.list` and `file.metadata` are accepted. The bounded primitive JSON
response has the distinct success shape
`{ok:true,protocolVersion:1,feature,catalog:{authorization,continuity}}`.
Failures use `{ok:false,protocolVersion:1,code}`. The consumer requires exact
feature echo and the original grant proof, with no ordinary/download fallback.

The shared publication-history reader accepts an explicit feature; its default
remains `file.download`, and history digest material is unchanged. The requested
catalog permission must exist in the original grant and in both current joined
producer permission checks. Client reuses the unchanged, feature-neutral 0235
candidate view and checks current local state before and after private RPC.
Missing new reader capability fails closed. No new environment variable or
grant/publication mutation is introduced.

Discovery requires `folder.list`. Listing directories requires `folder.list`;
file entries additionally require a separate `file.metadata` proof for the same
original/current anchor. List-only pages filter out file entries before LIMIT,
so hidden file entries cannot drive pagination. A metadata-only grant can read
an authorized file selector but gains neither delivery discovery nor listing.

## Selectors and requests

`wpc1_` encrypted folder/file/cursor selectors use their own AES-GCM purpose and
authenticated prefix. They bind original canonical grant fingerprint, person,
authority, effective publication's six pins, chain digest/count, relative path
and expiry. File selectors also carry indexed ETag/size, not R2 provider version
or SHA256. They are metadata selectors, never byte authority. TTL is bounded by
15 minutes, original grant and current verified human session.

Cursors bind their scope, parent path, original grant/person, effective
publication and sort position. Stale publication or parent selectors fail;
restart discovery instead of mixing pages. Directory offsets use Unicode code
points to match SQLite `substr`, including non-BMP folder names.

All endpoints are authenticated GETs under
`/api/client/operations/data/windows-catalog` on the exact configured primary
portal with one verified human Access audience. Machines, alternate origins,
cross-site calls, unexpected/duplicate query keys and encoded selector aliases
are rejected. Responses are private/no-store.

| Request | Success shape |
| --- | --- |
| `/deliveries?cursor=...` | `{schemaVersion:1,resourceMode:"windows_portal_catalog",items:[{id,displayName}],page:{nextCursor}}` |
| `/folders/:wpc1?cursor=...` | `{schemaVersion:1,resourceMode:"windows_portal_catalog",folderId,prefix:"",files:[{id,name,size,downloadAvailable}],folders:[{id,name}],breadcrumbs:[{id,name}],cursor}` |
| `/files/:wpc1` | `{schemaVersion:1,resourceMode:"windows_portal_catalog",file:{id,name,size,downloadAvailable}}` |
| `/files/:wpc1/download-manifest` | Existing nine-field Windows manifest with a dedicated `wsp1_` byte URL |

The page maximum is 25 entries. Discovery authorizations run in batches of at
most four, preserving result order. Every admitted batch drains before an error
or the next batch. All initial results finish before the final authorization
phase; its results and human expiry are checked before any page is returned.
This bounds concurrency; it does not replace live latency qualification.

## Transition to downloads

`downloadAvailable` describes the immutable grant's feature set. It grants no
content. Manifest requests and queue reference creation independently obtain
fresh `file.download` successor proof, compare its original fingerprint and
complete continuity anchor with the metadata proof, and retain the original
durable selector lifecycle. A final proof protects reference handoff. Catalog
reference selection reads neither file index nor R2 and does not append content
audit. Resolve later obtains current verified content pins.

Only the dedicated successor byte router accepts the resulting `wsp1_` token,
with mandatory audit, R2 identity and repeated current authorization. `wpc1_`
tokens are rejected at byte routes. Existing `ond1_` references remain supported.

The .NET `PortalClient` uses the new explicit catalog protocol and strict DTO
fields, preserving public record APIs for the desktop interface. There is no
silent legacy catalog fallback. Queue selection accepts only `ond1_` or `wpc1_`;
download URLs remain limited to exact same-origin old `ond1_` or new `wsp1_`
routes. Installers must not ship before coordinated staging deployment and
actual desktop sign-in/provisioning/revocation/resume qualification.
