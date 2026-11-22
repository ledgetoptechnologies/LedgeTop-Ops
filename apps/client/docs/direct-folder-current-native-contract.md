# Direct client-profile folder sharing: current-native successor

Status: locally qualified source candidate; feature default OFF; live readiness unproved.
This document is a source contract, not a deployment, migration or access grant.
Merger owns integration and activation. PR422 remains held until successor coverage
is independently proved. No Viewer, production configuration or retained assets
are changed by this source work.

## Models and recipient provenance

The current Operations-native model consists of an acknowledged workspace
reservation/publication and native recipient/service-home authority. It does not
create PA-v2 workspace, identity, membership or directory-generation rows. Those
rows must never be manufactured to bridge this flow. This direct-folder grant
feature is Operations-native only and is available only when both the explicit
Client native-recipient-service-home setting and the direct-folder setting are
enabled. In PA-v2 mode its capability is false and the feature stays off; native
authority failure never falls back across models. Existing registered PA-v2
authenticated-delivery, history, and revoke flows remain separate and available
under their existing routes and authorization.

For native recipients, the selected client record must match a current published
child (or standalone root) and a receipt-backed native recipient binding with
verified issuer/subject, current workspace epoch and grant revision, exact command
fingerprint/permissions, and unexpired access. Organization sharing explicitly
selects the published organization root and includes its eligible recipient
bindings. Selecting a child never includes its siblings' users. Neither an email
address nor organization membership alone creates selected-child authority.

The existing PA-v2 authenticated-delivery flow retains its own live
identity/membership/projection checks. This direct-folder grant feature does not
create PA-v2 direct grants or read PA-v2 membership rows. A child selection must
be backed by its current native recipient binding and cannot expand to sibling
clients.

## Dataflow and schema

1. Staff selects a real indexed folder and an Ops client or organization. Existing
   folder browse/share/revoke ACLs still apply. No PA project, folder reservation,
   model association, or client-side business chooser is required.
2. Ops verifies current record/relationship versions and exact acknowledged
   reservation/publication/checkpoint/receipt pins, then calls the existing private
   Client authority service for selected-recipient readiness and count. A separate
   authenticated per-folder capability reports native readiness plus actual scoped
   create/revoke permissions. It changes neither the strict session capability DTO
   nor the recipient-list DTO and does not depend on PA projection readiness.
   An absent old-server capability endpoint may retain the separate legacy UI;
   a known endpoint's denied folder admission returns generic403, and failed or
   malformed readiness is503. Neither silently selects legacy authority.
3. Review binds staff, canonical folder, recipient, authority, membership, expiry
   and publication. Creation/revocation use stable operation IDs and exact request
   fingerprints. The grant, mutation receipt and audit commit atomically.
4. New migration0244 records the explicit authority model and references the real
   native workspace authority target. It must not require a PA-v2 workspace row
   for a native-only home. No migration is applied by this source work.
5. Authenticated discovery/list/open/preview/download use encrypted, expiring,
   principal-bound resource handles. Native-only portal discovery is admitted
   through its existing verified home model, independently of PA-v2 sessions.
   Reuse the existing media reader and safe object/tombstone filtering.
6. Native-only files appear in the existing single client portal. PA-v2 files keep
   their registered client navigation. Missing schema/binding/contract responses
   are unavailable, never fabricated empty lists.

## Readback, revocation and recovery

Every file operation rechecks selected-profile authority, current publication,
workspace epoch, expiry, grant version/state and principal. Removing a native home,
changing its profile binding, or revoking the folder grant invalidates old handles.
Organization grants do not bypass recipient revocation. Public links are unchanged.

The Client mirror is insufficient evidence that Ops still acknowledges that
publication. Native reads also require a fresh read-only response from the existing
private Operations authorization binding. That response verifies the actual current
grant row, Ops workspace/reservation/publication/current-checkpoint and exact
recipient authority. It has a fresh request nonce/hash and bounded observation time;
the Client compares its publication pins and repeats the check around content I/O.
Missing/malformed/late RPC or divergent mirrors do not fall back to PA membership.
A workspace or recipient pin that changes during the local read is unavailable,
not an apparently successful empty listing.
This adds a distinct method to the existing private reader; it adds no public HTTP
authorization endpoint and requires no business project or folder reservation.

Grant publication fields record the creation review, rather than freezing every
later membership to that snapshot. Reads use the current acknowledged publication
and current selected-profile bindings. A harmless publication advance may preserve
a grant; a stale current checkpoint or removed relationship cannot.

A post-dispatch exception or failed readback is an unknown outcome. The UI retains
the exact body/key, prevents another action, and retries that operation. A revoke
replay must reach the private receipt ledger; matching state/version alone is not
proof of replay. Different operation IDs cannot turn a revoked grant into success.
Current readback may be unavailable after authority changes; do not issue a new
grant to hide that uncertainty. Retained legacy grant history/revoke controls stay
reachable separately. Their original registered creation/restoration controls
remain governed by their existing legacy capability and administrator gate. Direct
sharing uses server-confirmed per-folder permissions, including revoke-only staff;
that does not grant public-link creation. Denied paging/revalidation clears old
private listing/selection data. Tab hides clear private views while preserving a
possibly committed mutation's exact retry command and locked state.

## Required local acceptance before review

- Actual full Operations and Client migration chains, not minimal mocked tables.
- Current native-only recipient discovery and selected-folder creation/opening,
  with zero fabricated PA-v2 workspace or membership rows.
- Existing registered PA-v2 authenticated-delivery, history, and revoke flows
  remain unchanged; direct-folder capability is false in PA-v2 mode and no
  PA-v2 direct-grant row or denial fallback exists.
- A selected child excludes a different current sibling recipient; explicit whole
  organization scope includes only eligible current bindings.
- Wrong principal, stale/absent receipt, changed epoch, expiry, membership removal,
  grant revocation, sibling folders and forged handles deny reads.
- Exact create/revoke retries, lost acknowledgments and failed readback produce one
  effect/receipt/audit or a preserved unknown outcome, never duplicate grants.
- Typed adapters, current frontend builds and bounded desktop/mobile browser checks.

Local tests do not prove Cloudflare Access, live staging/client consent, real media
rendering, production permission changes or the 48-hour deployed asset requirement.

## Local qualification, November 15, 2026

- Operations/Client complete migration-chain cohort:17 passed, including the new
  direct-folder case and the original native-delivery acceptance. The direct case
  checks child/sibling and organization scope, lost create/revoke acknowledgments,
  revoke-only history, real native-home revocation, stale checkpoint, R2 range,
  stale If-Range, HEAD and a tampered encrypted handle. No PA-v2 rows are invented.
- Focused Ops source/capability checks:19 passed (overlaps15 tests in the cohort).
- Client checks:35 passed, including the existing authenticated-delivery resources.
- Ops desktop/mobile:120 passed before the last direct-history privacy refinement;
  final direct-sharing cohort46 passed after that refinement. Client desktop/mobile
  folder suite8 passed. Browser endpoints are mocked; video bytes are synthetic.
- Both app typechecks and worker/frontend builds passed. Nine retained native-route
  and migration static checks passed. Build large-chunk warnings remain nonblocking.

These are Windows/local source results, not Linux CI artifact or deployed Workerd
RPC/Access acceptance. No production/client grant, provider, migration, flag or
retained browser asset was changed. The private reader uses an existing binding;
Merger must verify both deployed methods, native recipient admission, migration0244
and explicit feature gates before any live enablement. The full goal remains open.
