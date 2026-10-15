# Native project archive/restore backend candidate

This candidate adds an Operations-native backend for **archive and restore**. It
requires migration `0204_native_project_archive_restore.sql` and a separately
reviewed release. It has not been deployed or accepted in staging. It adds no UI
controls and does not implement complete or cancel.

The routes live beneath the existing authenticated Client Hub business owner
context at `project-management/native-project-lifecycle`. Normal staff
authentication and mutation CSRF protection apply. The native session must match
the Operations principal, and the original actor must have current explicit
`project.shared.sync` permission with deny precedence. Source, application,
instance, history epoch, owner context, local version and projection hash remain
pinned throughout the operation.

1. `prepare` freezes an archive/restore intent and returns its review hash.
2. `submit` requires that hash and an explicit `reconcile: false`. It reserves a
   lease, repeats current authorization/context checks at the final network
   boundary, and records a durable marker before the underlying PA POST.
3. `refresh-prepare` separately prepares the exact binding revision refresh after
   a validated lifecycle acknowledgment. `refresh-submit` requires its own review
   hash. This is an explicit child command; there is no automatic rebind.
4. Refresh project inventory through the existing reviewed inventory path when
   an older observation exists. Readers continue to deny stale inventory,
   binding drift and conflicts.
5. `activate` rereads the exact PA project and binding. Only a matching lifecycle
   receipt, refresh receipt and canonical read permit the local version advance.
   The normal project list excludes archived projects and shows restored
   projects under its existing status filters.

The command status GET reports durable state under current native authority.
Known failures before the network marker return an initial claim to `prepared`.
An actual POST with a lost response or an unpersisted acknowledgment remains
`uncertain`. Recovery requires a fresh, explicit authorized submission with
`reconcile: true`, preserving the original immutable command ID, body and source
tuple. There is no automatic resend, replacement ID or invented PA receipt GET.
The refresh child follows the same rule. Bare HTTP 409 does not prove an unknown
command had no effect.

If a known accepted action is superseded by an authentic strictly newer PA
detail, `retire-for-inbound-review` preserves the acknowledgment and records
`inbound_review` without a remote POST or canonical activation. It rejects
unresolved sending/uncertain children. Existing inbound proposal and resolution
review may then proceed; other writers remain fenced until an exact reviewed
inbound acceptance advances the original head. Existing inbound owner-change
restrictions still apply: an owner change may require follow-up rather than
canonical acceptance. The handoff does not force convergence or refresh a
binding.

Expiration **does not release the durable writer fence**. The original actor,
with current authorization and the current owner context, may explicitly abandon
only a proven-zero-POST preparation through `abandon-preparation` or
`abandon-refresh-preparation`. Expired or revoked authority is insufficient.
Permanent actor-admission or owner-mapping retirement requires separately
reviewed operator recovery. Close a staging authority window only after settling,
reconciling or safely abandoning every command; revoke temporary grants afterward.

Canonical readers accept lifecycle history only through an exact, decreasing
activation lineage back to legitimate v2 settlement, including reviewed inbound
steps. Repeated archive/restore cycles preserve owner links at each lifecycle
step. Older schemas retain their existing read behavior; partial lifecycle
schemas fail closed. Existing financial permission, inventory, conflict,
publication and grant predicates remain required. The workflow does not grant or
revive financial access, send email, write documents or rewrite public URLs.
Archive intentionally revokes PA project presentation; restore does not republish.

The candidate also corrects inbound review of fresh GETs: request IDs vary between
reads, so comparison excludes only the root `requestId` while preserving every
other validated envelope field. Both original and final raw responses and hashes
remain durable evidence; a changed semantic field still blocks resolution.
