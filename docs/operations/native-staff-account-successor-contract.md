# Operations employee account successor

Source contract for review, November 13, 2026. This document does not enable
accounts, change Access, reserve a migration number, or claim runtime readiness.
Merger owns composition and deployment; PA-Ops Integration owns this backend
contract; Claude retains the existing document/UI source and Logs fixes.

## Authority and continuity

Operations owns its employees and their lifecycle. Each Project Alpha instance
continues to own its own people. Client synchronization is a separate feature.
Keep stable Operations staff IDs, verified Access subjects, alternate sign-in
bindings, current ACLs, audit history and historical PA reference IDs. Do not
delete PA users or use a PA entitlement as Operations admission authority.

Cloudflare Access authenticates the person; current Operations D1 admission and
scoped capabilities authorize their actions. Native staff management does not
mean a new password authentication system. Preserve safe return-to-login and
verified alternate-email linking. Editing a display name or contact field must
not silently rebind a primary login identity.

## Reuse before implementation

Selected main source: `454e62198c359147a5750cd658c29eb05db6371c`.
It has name editing, enable/disable, scoped delegation/deny rules, joined
identity fencing, last-control-plane preservation and alternate login binding.
Its existing HTTP lifecycle handler explicitly excludes create/bootstrap/grants.

Retained, unmerged `codex/ops-managed-staff-invitation-20261110` at
`8389e5ff4e05b700830bd599e6fb7c4ecbd08a87` already contains pending invitation
create/reveal, verified claimant, approval/cancellation and tests. Preserve it.
Review and compose its relevant files; do not recreate those services or merge
the whole older tree. Its proposed Operations `0232` approval migration is not
selected or reserved by this contract. After the initial contract, Merger
reserved `0242_native_staff_onboarding_approval_actor_authority.sql` for the
account implementation. Its SQL must remain byte-identical to the donor;
`0232` is also used by a retained, closed iOS pilot branch. This reservation
does not authorize applying the migration.

Retained `codex/ops-crm-staff-integration-20261110` at
`2cfde333dd1acab4a4c020223b94271110b7feb8` contains that staff source plus CRM
and staging-ledger work. Do not bring its synthetic CRM import, client authority
or release-profile changes into employee management. Its proposed CRM `0233`
conflicts with the current request successor's `0233`; never compose by number.

Historical Claude documents branch `778b8e39b16471efe26b6c13a583519d9be5fb83`
and title successor `79eb3a0174581be7c7a65e7e1e419650a7b47871` are retained
donors only. Their personnel `0225`/`0226`/`0227` migrations collide with main.

## First account implementation slice

1. Administrator reserves an invitation with a server-generated stable staff
   ID, name and exact intended login email. Pending is not an active employee.
   Existing scoped `staff.onboarding.create` authority and explicit denies
   remain authoritative. No role, membership or Logs grant is implied.
2. A one-use, expiring invitation is claimed by the intended person using an
   actual verified human Access session for the configured claimant audience.
   Exact email, subject, audience, origin, CSRF and secret are checked. A link
   or email address alone cannot establish identity. The claim creates no ACL.
3. An authorized reviewer approves the exact claim/proposal/version. Retain
   existing independent-review constraints; the claimant cannot approve their
   own admission. Preserve immutable receipts, cancellation and same-command
   replay. No PA account is created or required.
4. Initial approval preserves the retained empty-ACL proposal. Selecting scoped
   employee permissions is a separately reviewed command with current ceilings
   and denies, rather than an implicit global employee role.
5. Edit names through existing fenced commands. Add contact metadata without
   changing verified login. Login changes use verified linking/recovery, not a
   plain email UPDATE. Archive/deactivate denies new requests and controller
   use while retaining identity and records. Restoration must not revive old
   capabilities, machine grants or revoked sessions automatically.

The donor's claimant route is staging-only/default-off and needs its own exact
Access audience; no such application or account is created by this document.
Production onboarding remains unavailable until that contract is deliberately
qualified and transitioned. A green donor test or encrypted invitation alone
does not prove this workflow or current-owner recovery.

## Explicit Logs eligibility slice

An optional controller username is an identifier, not a permission. Logging
eligibility must be a separate explicit, audited grant, with deny taking
precedence and no automatic grant for active staff. Decide the exact capability
and migration only after namespace and current-ACL review.

Enforce it at username resolution, controller request approval/token issuance
and existing device use. Keep current public method names compatible or version
the private RPC contract explicitly. A missing grant, unavailable authority,
archived employee or revoked eligibility fails closed. Revocation must take
effect within the reviewed device authority-cache bound (currently 60 seconds).
Do not derive eligibility from username presence, PA status or an email domain.
Coordinate with Claude's pairing reservation/security design; two writers must
not independently change the device approval contract.

## Later independently reviewable profile slices

- Private personnel documents: freeform display title, defaulting to filename
  when blank; no required category. Preserve immutable original file name,
  object version/hash, scanning/quarantine, audit and retention. Replacement
  appends a version; employee archive retains files. No ordinary permanent
  delete action. Admin/HR authority is separately scoped; own-record view is
  explicit and does not reveal all private HR documents. Clients never see it.
- Typed custom fields: administrator-defined bounded schemas and values,
  separate visibility/edit rights, validation and versioned audit. These fields
  cannot inject permissions, login identity or controller eligibility.
- Equipment: repeatable assignment/return history linked to stable staff and
  equipment IDs, dates, condition and optional documents. Reassignment closes
  history rather than overwriting it. Equipment access does not grant file or
  financial authority.

## Qualification and rollout

Before a source PR: inspect donor claim/approval/cancel/replay and owner recovery
against current auth, independently review the exact composition, audit all
open migration candidates, and reserve exact filenames through Merger. Preserve
frozen source/profile guards instead of widening a historical cutover.

Required staged tests include wrong human/audience/email, stolen or consumed
link, expired/stale/cancelled invitation, same-command replay and conflicting
reuse, concurrent claim/approval, no implicit ACL, explicit deny, last usable
owner preservation, archived access denial, old device/machine grant rejection,
and independent PA/client behavior. Test actual service requests and document
bytes under their own scopes; empty lists and mocked identity are insufficient.

Activation requires verified current cohort and Access continuity, exact schema
and service readbacks, staging acceptance and an approved release. Preserve the
48-hour frontend asset bytes and all original deployment/migration journals.
No provider, database, credential, identity or production change is authorized
by this source contract alone.
