# Native Operations staff authority

September 11, 2026. Local implementation checkpoint, not production activation.

## Ownership

- `native_staff_admissions` is the sole native account-active and verified Access
  subject-binding authority. Changing PA activation or roles must not alter it.
- `native_staff_profiles` owns the native login email, display name and profile
  revision. It references the admitted permanent staff ID. It does not duplicate
  an active flag, Access subject, PA user ID or permission role.
- `staff_users` remains the historical foreign-key/projection bridge during
  migration. Its PA-controlled identity fields are not native authority. Do not
  reconcile them back over the native profile or silently adopt by email.
- Native profile creation is explicit. Migration alone must not copy existing
  users, admit the seeded owner, create permissions or change existing history.
- The native resolver accepts already verified human identity claims. It is not
  a JWT verifier and must not receive unsigned browser identity assertions.
  It requires exact email and subject plus active admission in a primary query.
  Its result deliberately lacks the legacy `StaffPrincipal` fields so callers
  cannot accidentally pass it through the old PA-role permission loader.
- Verified subjects are opaque bounded values, not resource-ID slugs. The native
  resolver and directory permission/read layers share validation and preserve
  exact comparison. Punctuation in a subject does not make it another identity;
  no lowercasing or other subject normalization is performed.

The separate profile is a narrow ownership boundary, not two-way synchronization
of staff profiles. Re-owning `staff_users` in place was considered; that requires
simultaneously changing snapshot, webhook, legacy login and identity mutation
paths. This foundation keeps those paths from becoming native authority before
the coordinated cutover. Historical IDs remain stable in either approach.

## Required before activation

1. Implement an audited native onboarding/bootstrap and profile-edit service,
   including deliberate identity binding and recovery. Preserve existing permanent
   staff IDs after explicit review; matching email alone is not identity proof.
   No request may invent an admission or use a `system` actor as a bypass.
   The [bootstrap and routine-administration contract](native-staff-bootstrap.md)
   separates a review-only proposal from transactional execution authority.
2. Preserve Access JWT signature, issuer, audience and human-identity validation.
   Switch the trusted resolver only together with native route authorization.
   Do not fall back to PA admission when native resolution denies access.
3. Retire/fence both `operations/project-alpha.ts` snapshot reconciliation and
   `ops-sync/projection.ts` webhook staff ownership. Resolve protected targets by
   permanent identity, not only the incoming PA email. PA must not modify native
   profile/admission, recreate roles or change native division memberships.
4. Replace legacy role and administrator authority in `acl.ts`. Its current
   role union and `isAdministrator` query remain PA-dependent. Existing roles
   are migration-review evidence, not automatic native grants.
5. Update direct identity/status policies in notification centers, delivery
   bindings, invitation review, staff inbox, and the SQL policies introduced by
   migrations 0043–0053. Native revocation must invalidate reads, writes and
   replay authorization; display-only preflight checks are insufficient.
6. Replace PA-user-ID-based assigned-work visibility in `visibility.ts` and
   related SOP/work consumers with native assignments. Preserve authorized
   existing work and explicit denials without manufacturing PA accounts.
7. Rehearse an Ops-only employee, a division manager, an explicitly admitted
   owner, wrong subject, changed email, revoked admission and a PA outage.
   Check public delivery/Viewer links independently; those contracts must not
   be accidentally replaced by staff-login migration.
8. Replace the PA-derived Access group membership calculation together with
   native login. `ops-sync/access-group.ts` now has a separate
   `desiredNativeAccessEmails` target query: active admission plus native profile,
   with no legacy owner exemption or PA entitlement union. It is deliberately
   not wired into the current reconciler. Cloudflare entry eligibility does not
   replace exact-subject application authentication or scoped permissions.
   Keep retry authorization and existing group constraints when changing the
   reconciler, and verify entry removal separately from immediate app revocation.

## Staff administration implementation boundary

- The maintenance bootstrap is not a staff-management role. Version-1 initial
  grants cover directory operations only; version 2 requires separately explicit
  administrative delegations in its approved payload. There is no implied ability to
  create employees, change their subjects, grant permissions or set pay.
- Routine administration must use native, explicit administrative permissions
  and target scopes, not `acl.ts`'s legacy `isAdministrator` role check. That
  query still reads PA-compatible `staff_role_assignments`.
- Read/profile edit, admission disablement, verified identity recovery, and grant
  delegation are separate actions. A manager allowed to edit a person's display
  name must not thereby gain the right to bind that person to a different login.
- Delegation must bound both the people managed and the permissions/scopes that
  may be granted. A user's own operational grants are not delegation authority.
  Business ownership and compensation policy remain independent of these rights.
- Native administration needs a current authorization check inside the same
  transaction as versioned state changes and immutable audit. Public routes and
  the admin UI must not be enabled while those services are still missing.

### Local administration checkpoint

Migration 0061 and `native-staff-administration.ts` implement two commands:
display-name edits and admission disablement. The first cannot change login
email or bind a different subject. Disablement preserves the admission marker
and historical grants rather than deleting them. Explicit native administrative
delegations support global, business-area, division and exact-person targets;
directory permissions and PA roles confer no implicit administration rights.

Each command requires expected versions, current verified actor authority, an
attributed reason and a durable command identity. State changes and audit commit
together. Replays require current authority and never repeat the mutation.
Last-global-staff-admin protection is checked inside the mutation transaction,
not just through a UI warning. This refers to the two supported management
actions, not to ownership, compensation or every future administrative power.

The expanded local suite passed ten cases, including audit-failure rollback,
wrong-subject and revoked-delegation replay denial, positive scoped access and
unrelated-division denial. The real migration chain through 0061 passed
three cases, including preservation of an existing revoked admission. These
results do not activate native authentication. Routine onboarding, delegation
editing, target-membership editing, verified identity recovery, administrative
read/impact views and route/UI wiring remain required. The version-2 bootstrap
work explicitly supplies initial authority without promoting old approvals.

## Projection-fence release prerequisites

- Both snapshot recovery and Ops Sync use the same Operations D1 schema. Their
  new admission predicates require migration 0057 before these Worker versions
  run; a missing table must fail rather than silently restore PA staff authority.
- An admission row is a permanent ownership marker even after `active=0`.
  Revocation is not permission for a subsequent PA event to reclaim that staff ID.
- PA source caches may continue to record staff/business events for source
  history. Those cache writes are not native admission, roles or assignments.
- Fence installation alone does not make old authentication honor native
  revocation. Do not create production native admissions and assume the cutover
  is complete: native authentication, authorization, consumer queries and the
  Access entry calculation must be joined and tested before authority switches.

No live login, worker configuration, PA deployment or production grant changes
are authorized by the existence of this document or its local schema alone.
