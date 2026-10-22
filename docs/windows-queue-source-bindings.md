# Durable Windows queue source bindings (unmounted)

These factories are source-only. They do not activate employee or portal routes,
grant access, deploy a gateway, or qualify live storage. They support native
employee server files and native Operations portal R2 delivery; PA legacy
membership and public shares are not queue sources.

For employee files the base is `/api/staff/files/queue`; for native portal files
it is `/api/client/operations/data/queue`. All operations are authenticated GETs:

| Route | Exact success DTO |
| --- | --- |
| `/session` | `{schemaVersion:1,principalId,expiresAt}` |
| `/reference?rootId=...&path=...` (employee) | `{schemaVersion:1,principalId,resourceRef}` |
| `/reference?fileHandle=...` (portal) | `{schemaVersion:1,principalId,resourceRef}` |
| `/resolve?resourceRef=...` | `{schemaVersion:1,principalId,manifest}` |

`manifest` retains the existing nine-field download manifest, including a newly
minted short download path. References do not prepare a gateway copy or issue an
R2 HEAD. Resolve prepares the employee immutable snapshot or reads trusted R2
checksum/version metadata. This avoids copying a large server file twice merely
to select and enqueue it. A nonexistent employee path can therefore be selected;
it fails when resolved, before any byte transfer.

Principal IDs are `odqp1_` plus 64 lowercase HMAC hex characters, separated by
source, exact HTTPS origin, Access issuer and single app audience. The human
subject is always server verified; employee IDs additionally bind staff ID and
native admission version. They exclude email/profile edits and JWT renewal.
Every source starts with actual fresh human Access verification, including
machine identity rejection. Principal IDs are neither identity credentials nor
authorization.

References are bounded `odqr1_` encrypted selectors with a 30-day maximum life.
A dedicated explicit queue key derives separate AES-GCM and principal HMAC keys
through HKDF. AAD binds the source/origin/issuer/audience. No assertion, cookie,
storage prefix, host path, temporary byte handle, prepared snapshot or URL is
stored in a reference. Key changes invalidate references; no fallback key or
automatic migration is supplied in this source milestone.

Employee references pin gateway/root ID, root generation and fingerprint,
human/staff/admission epoch, exact grant ID/generation and canonical relative
path. Resolve uses the exact old grant; another allow cannot rescue its
revocation. Current profile versions are resolved afresh. Snapshot IDs and
content versions are renewed rather than frozen in the reference: changed
content is returned as changed manifest pins, which the durable queue records as
VersionChanged without touching the old partial.

Portal references retain every existing native selector authority lifecycle
pin: recipient/enrollment/client, target/workspace, home ownership and grant,
delivery authority revision, publication operation/revision/source sequence and
published snapshot, folder reservation/binding and project version, plus the
relative path. Short expiry, object etag/provider version/SHA are excluded.
Resolve first obtains fresh current Ops authorization, compares the exact old
lifecycle through the existing matcher, then resolves current index/R2 metadata
through the existing native manifest implementation. Revocation, regrant,
ownership change, folder remap or changed publication pins fail closed.

## Portal publication continuity remains unfinished

The unmounted `windows-portal-publication-chain.ts` evidence reader now proves
one prerequisite: an uninterrupted, bounded sequence of acknowledged applied
publications retaining the original folder mapping, project version and owner.
It checks every intermediate publication, so omission followed by restoration
fails. It pins the exact acknowledged active grant wire and original expiry,
rechecks the current grant/publication afterward, and returns only publication
identities and a chain digest. Migration 0224 adds its target/sequence index.
The maximum is 64 publications including the original; longer history needs a
separate continuity-epoch design, not silent truncation.

The history component alone is not content authorization. The source now adds
`readWindowsDeliverySuccessorAuthorization(canonicalOriginalGrant)` on the existing
private Ops service-binding entrypoint. It uses the same deployment admission as
the ordinary reader, accepts only bounded exact canonical grant JSON and returns
a bounded primitive JSON string. It is not deployed or exposed as HTTP.

That method proves history retention, checks current producer home/recipient/
folder/project/physical mapping with the effective publication, proves history
again, and finishes with another current joined permission query. It returns
`{ok:true,protocolVersion:1,successor:{authorization,continuity}}`. The original
grant authorization retains its original publication and expiry;
`continuity.current` separately identifies the effective publication. Failures
distinguish disabled, invalid, denied and unavailable, with no internal errors.
The ordinary reader still requires its original publication. Neither issuer nor
grant head is mutated to manufacture continuity.

The separate source-only consumer authorizer now proves current local
home/grant/publication/resource state, validates the distinct response against
the original grant and local effective publication, and rechecks local state
after the bounded private RPC. It returns a distinct context and has no fallback
to ordinary authority. Original views, queue resolution, byte routes and audit
are unchanged. The next integration must preserve original queue lifecycle pins.
Purpose-separated successor handles and content-start audit must bind both
original grant and effective publication before any index/R2 access or byte
handoff. Queue resume across a publication change is still unfinished.

A normal publication refresh currently returns 409 for an old queue reference.
That is an explicit source limitation, not the intended final restart/resume
experience. Removing publication or delivery revision pins would allow an old
selector to follow replacement authority and is not a safe continuity contract.

The existing authoritative producer seam is
`operations-portal-native-delivery-authority-issuer.ts`'s `contextSql`, which
joins native workspace/recipient heads, acknowledged home receipts, current
publication heads/receipts/commands/checkpoints, published folder/project
sources, and current folder reservations/project revisions/physical mapping.
Its delivery authority heads and dispatch also carry exact lifecycle versions.
The ordinary portal authorization RPC proves one exact current publication. The
separate successor RPC source supplies the producer-side proof only.

The next consumer protocol must preserve the proved uninterrupted delivery grant,
recipient enrollment/home ownership epoch, target/client/workspace and
folder/project mapping. A later stable continuity epoch can replace the bounded
immutable-history scan without accepting omitted or unprovable history. The
portal must check the transition and repeat fresh authority checks. Tests must cover
ordinary metadata refresh with same-content resume, changed version, intervening
revoke/regrant, ownership/client switch and folder remap. No existing content
route gains cross-publication authority from the new producer method alone.
