# Native staff bootstrap artifact composer

The artifact composer prepares a private, review-only draft from the exact
snapshot returned by `readNativeStaffBootstrapSnapshot`. It performs no
credential reads, signing, approval issuance, network access, or D1 writes.
Its output is explicitly `draft-not-approved` and contains staff identifiers,
Access subjects as hashes, binding evidence, and permission rows; keep any
populated artifact in an owner-controlled private location.

## Observed and planned control plane

The input `controlPlaneStaffIds` must exactly match the snapshot's current
control-plane candidates. This is the observed prestate. The canonical plan
and binding evidence separately record `plannedControlPlaneStaffIds`, the
expected post-batch candidate set. A preserved owner who is not a current
candidate can appear in that planned set only when the exact plan supplies the
complete explicit initial authority package below. The owner is never silently
added to the observed snapshot, and the owner is never added to the employee
cohort or re-admitted/re-profiled by this composer.

The initial owner package contains nine new `native_staff_management_delegations`
for the six global control-plane actions and three global lifecycle actions,
plus eleven global `native_staff_delegation_ceilings` for the control-plane
capabilities and their allow/deny and create/revoke boundaries. All rows must
be active allows at contract version 1, have null narrower-scope fields, use
the owner as actor and grantor, and connect ceilings to the matching owner
delegations. Denies, missing rows, wrong domains, scoped/resource-bound rows,
or non-owner provenance fail composition. These requirements mirror the
candidate views in migrations `0068_native_staff_control_plane.sql` and
`0225_native_staff_lifecycle_bridge.sql`; the installer remains authoritative
and checks the actual post-insert views in its atomic transaction.

## Employee and existing authority

The proposed employee must be an exact active `staff_users` row with its
existing bound Access subject, email, and display name. The composer derives
only that employee's admission and native profile. Memberships or other
permissions must be listed explicitly and are bound into the plan hash. Legacy
PA roles and effective permissions are never copied or interpreted as native
authority. Existing owner and preservation-person admissions, profiles,
grants, assignments, and history are not rewritten; owner-as-actor rows are
limited to the complete initial management package. Directory grant and
directory assignment rows remain outside this composer.

## Approval and execution

Composition is not owner consent. Execution still requires the separately
provisioned trusted approval issuer, exact owner identity verification, typed
consent bound to the plan, binding evidence and snapshot hashes, and the
approved installer source/target pins. The D1 executor independently checks
that snapshot state is unchanged, inserts the proposed rows and receipt
atomically, and verifies that the actual post-batch control-plane candidates
match the plan. Do not use a synthetic test verifier or synthetic test artifact
for production approval or execution.
