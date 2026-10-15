# Native staff bootstrap and ongoing administration

September 11, 2026. Implementation contract; execution is not yet enabled.

## One-time bootstrap

- Prepare a review-only manifest of exact permanent staff IDs, proposed native
  login profiles, proposed verified-identity bindings and explicit initial
  grants. Existing PA role names are context only, never executable authority.
- Existing bridge rows require an exact reviewed snapshot. New bridge rows are
  explicitly new; an email collision is a review failure, not a merge instruction.
  Preserve existing historical foreign keys and PA source mappings.
- A syntactically valid subject is not proof of who controls it. Verify binding
  through the trusted Access identity flow before executing the reviewed proposal.
  The planner must not label its output authenticated, approved or authorized.
- Keep review artifacts private: they contain staff identifiers and email
  addresses. Commit the planner and synthetic fixtures, not a populated manifest.
- Initial administrative authority needs an explicit owner-reviewed maintenance
  procedure. A browser request cannot bootstrap itself by supplying an owner
  name, a manifest hash, an approval boolean or a `system` actor label.

## Execution requirements

- The local executor consumes a durable, one-time maintenance
  approval installed through a separately trusted review procedure. Approval
  must bind the exact plan, operator subject and independently verified binding
  evidence, with an expiry and revocation state. It is not created by the
  executor, supplied as a boolean, inferred from PA roles or exposed as a route.
- The same owner may review and execute a maintenance bootstrap. Preserve issuer
  and operator attribution, but do not require two different people or an already
  admitted native administrator for the first native account. Privileged approval
  installation is a separate trust boundary, not an application self-service API.
- Exact replay may return the historical receipt only under current valid
  approval/operator authority. It must not recreate grants, refresh admission or
  undo a later revocation. An expired or revoked approval cannot execute again.
- Use database time for approval expiry. Reject an oversized execution before
  mutation; never silently split one approved atomic plan into partial batches.
  Planner validation bounds are not a promise that every plan fits execution.
- Execution is bounded to 16 staff entries, 128 total grants and 256 KiB of
  canonical plan JSON. Oversized proposals must be deliberately reviewed as
  separate plans; execution never silently fragments an approval.
- The executor must re-read the exact reviewed bridge, current native state,
  target business areas/divisions/resources, and subject/email uniqueness inside
  its write transaction. A valid plan is not proof that state remains unchanged.
- Admission, native profile, initial grants and immutable attributed execution
  receipt must commit together or all roll back. Stable command identity and
  exact replay matching prevent partial retries or duplicate grants. A hash is
  useful for comparison, but is not authentication or permission to execute.
- Reject unexpected preexisting native profiles/admissions, any preexisting
  native grants (including inactive grants), or changed bridge
  snapshots rather than overwriting them. Preserve revocations; replay must not
  reactivate a subsequently revoked person.
- Review the resulting effective permissions before activating login. No
  automatic copying of legacy owner/admin roles, PA access, compensation policy,
  customer billing visibility, website access or Viewer processing permissions.
- Do not enable the native login resolver until the legacy writer and consumer
  changes in `native-staff-authority.md` have passed joined acceptance tests.

### Initial administration authority must be explicit

The current version-1 bootstrap manifest contains directory grants only. A
successful receipt therefore does **not** make its recipient a native staff
administrator, even when that person was an owner in PA. Before native login
cutover, a reviewed bootstrap contract must also install the explicitly approved
staff-management delegations and organizational memberships. Bind these to the
same canonical approved payload and transaction; do not synthesize them after
execution from legacy roles or a directory-wide grant.

Changing this payload requires an explicit contract version and new approval.
An existing version-1 approval must retain its exact meaning and must never
acquire administrative permissions because the executor was upgraded. Test both
preserved version-1 replay and the new administrator's actual ability to perform
an authorized staff command. No HTTP request may self-install this initial
authority. A single owner may use the separately trusted maintenance procedure;
independent identity evidence does not require a second business owner.

The local version-2 proposal is specifically an initial-administrator bootstrap.
Its named authority must be an existing reviewed bridge included in the cohort,
with explicit global allows for `staff.profile.edit` and
`staff.admission.disable`, and no deny for either action at any scope. An
incomplete proposal is rejected rather than repaired by inventing permissions.
This matches the administration service's conservative last-global-administrator
definition. Local expanded executor rollback and replay tests now pass; this
proposal is not permission to activate native production login.

## Routine staff administration

- After bootstrap, normal onboarding uses a separately authorized, audited
  native administration service. It does not require the owner to manually
  approve every routine customer or employee action unless policy requires it.
- Permission to edit a customer, create a project, or manage a division is not
  permission to administer staff, grant oneself privileges or change pay rules.
- Grant-management authority must have an explicit delegation boundary: actions,
  permissions and scopes it may assign, with applicable denials enforced. Do not
  equate "can use permission X" with "can grant permission X to others".
- Changes need expected versions, actor/beneficiary attribution, reasons,
  immutable audit and transactional authorization. Staff disablement and subject
  recovery must invalidate fresh requests and replay authorization consistently.
- Provide a deliberate recovery path for administrative lockout and show the
  impact before administrative revocation. Do not silently preserve ordinary
  access because a former employee had a high role.

## Remaining acceptance

- Version-2 local acceptance: combined v1/v2 planners and executors passed
  **35/35 tests** (48.51 seconds). The final strengthened v2 executor rerun
  passed **9/9** (23.21 seconds), with TypeScript and diff checks passing.
  Coverage includes late-delegation rollback of the new bridge, admissions,
  profiles, grants, memberships, delegations and receipt; exact replay after
  admission revocation; existing membership/delegation ID collisions; aggregate
  bounds; malformed/expired/revoked approval; and non-coercing identifier checks.
  The planner rejects a different cohort actor hidden in the authority's entry.
  These tests do not establish live bootstrap approval or full staff-management
  UI readiness.
- Local Miniflare D1 verification passed: 11 tests across the executor and full
  migration chain, followed by 9 executor regression tests on the final code.
  Coverage includes ID preservation, explicit new staff, collisions, stale
  review, existing grants, approval validity, rollback, concurrency and replay.
  These are synthetic local tests, not production staff migration evidence.
- A trusted maintenance approval-installation procedure and live identity
  verification remain required; this module exposes neither an approval issuer
  nor a runtime route. Receipt hashes describe immutable trusted database
  records, not an independent signature or a substitute for authentication.
- Verify an Ops-only employee, a scoped division manager and explicit native
  administrators; none needs a PA account merely for Operations access.
- Confirm PA snapshot and webhook events cannot regain staff authority after
  cutover, and that existing public delivery and Viewer contracts still work.
