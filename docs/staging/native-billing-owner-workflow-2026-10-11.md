# Native billing owner workflow — staging candidate

This candidate is not deployed or production-ready. It adds a recipient billing-access lifecycle; it does not create invoices, accept contracts, process payments, or grant staff administration permissions.

## Implemented boundary

- Review one explicitly selected native workspace target, recipient binding, and organization/client/project entity. No name/email matching or authority inferred from file access.
- Require current native staff admission/profile/subject and dedicated, scoped billing-management permission; deny wins. Owner role alone does not satisfy the billing issuer.
- Commit command, local outbox acknowledgment, receipt, grant finalization and current head in one D1 transaction. This is a local billing ledger, not a Client acknowledgment protocol.
- Preserve immutable operation identity and body for retries; reauthorize current actors and reject stale reviews, revisions, permissions and lineage.
- Permit another currently authorized manager to revoke the original manager's grant, including after publication/entity drift. Keep history intact.
- Show ledger state separately from effective live access. Expiry, denial, revocation and lineage drift fail closed.
- Use normal staff authentication, actor-bound CSRF, same-origin request checks, bounded closed JSON and redacted responses.
- Mount only through the exact staging entrypoint and separate, default-absent `OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED` gate. Production routing is not added.
- Require native browser confirmation for grant/revoke/retry. Lock mutation input after uncertain responses while allowing read-only status reconciliation.

## Verification

- Canonical full-schema real-D1 lifecycle test passes, including late-stage transaction rollback, expiry, altered-body/revision/review rejection, deny/generation changes, refreshed-session replay and distinct-manager revocation.
- HTTP/client/staging-gate suites: 18 focused tests pass.
- Owner UI: 16 desktop/mobile browser checks pass with ordinary clicks, including narrow-screen overflow, denied sessions, review invalidation and identical frozen retries. A denied retry-time session refresh keeps the original uncertain operation locked. No forced clicks or skipped mobile cases.
- Operations type-check and final candidate build pass. These checks are not proof of live acceptance.
- Independent read-only review found no concrete issuer/schema/staging-mount regression.

## Remaining release and authority gates

- The existing role/legacy ACL screens do not establish native global directory-management or billing-management grants. A reviewed, usable owner-authorized bootstrap/delegation path is still required. Do not seed billing authority tables or weaken the current issuer guard to make a demonstration pass.
- A read-only staging audit found no qualifying global native directory-management grant or effective billing-management grant for the selected owner. This is an authorization prerequisite, not an authentication failure.
- Publish a fresh reviewed candidate and require successful exact-revision CI. Earlier successful CI for the prior release does not authorize this new source.
- Use a new Ops-first preserved-runtime release profile. Required additions are Ops billing-owner and financial-RPC flags, then Client financial flag and its private financial-reader service binding. Preserve existing flags, bindings, handlers, schedules, container, schema and public links.
- Prove normal owner issuance, recipient PA financial reads, tenant exclusions and same-session revocation in staging. Existing local tests do not prove that live flow.
- Production routing/configuration and the owner PA-update checkpoint remain future gates; this candidate authorizes no production activation.

## Follow-up delegation surface (local work, not released)

- The normal resource-scoped staff billing delegation API/UI is mounted only in the staging entrypoint under the existing exact, default-off billing-owner gate. It does not create its prerequisite Directory management authority, infer it from a role label, or expose global grant mutation.
- Review selects one admitted staff member and one native customer resource. Issuance/revocation uses the existing immutable permission issuer, expected generation and original operation identity. Current owner identity, existing global native Directory management allow, and relevant denies remain enforced.
- An already authorized single owner may delegate scoped billing management to themselves; a second business owner is not required. This is distinct from bootstrapping the missing prerequisite authority.
- Independently reviewed maintenance setup is still needed for the existing admitted staging owner. The old first-account bootstrap must not be reused: its contract rejects preexisting profiles, admissions and grants.
- Delegation verification: 10 HTTP checks (including canonical real-D1 issue/replay/revoke), 5 client API checks, 14 desktop/mobile UI checks and 3 real-entrypoint dispatch checks pass. The revoke wire body contains only confirmation, operation ID and expected generation; its immutable grant ID is carried in the route. Review exposes only unrevoked exact-resource rows, not global policy or historical grants.
- The mounted delegation and retry fixes are a new local follow-up candidate. The earlier `0c19b11` release/CI evidence does not cover them; fresh publication and exact-revision CI are required before deployment.

### Exact maintenance setup to review before execution

- Target only the staging Ops account/Worker/database already used by this release. Add exactly one missing global native `directory.portal_access.manage` allow to the existing, verified owner. This is Directory portal-management authority, broader than billing; it is not a recipient financial grant.
- Use a separate domain-separated authority-upgrade approval and immutable execution receipt, never reinterpret old bootstrap approvals. An out-of-band trusted procedure installs approval only; no browser route manufactures its own approval.
- Bind approval to the exact canonical plan/hash, current owner/admission/profile/subject, current grant generation/history, independently verified identity evidence, operator/issuer attribution, expiry and revocation. Keep populated identity evidence private.
- Recheck all state and applicable denies inside the bounded write transaction; grant plus receipt must commit together or roll back. Preserve all old grants/denies, bootstrap approvals, staff records, memberships and audit history.
- Exact replay returns history under current authorization but never recreates revoked access. Reject expired/revoked approvals, changed bodies, different operators, stale identity/generation, existing conflicting IDs, concurrent reuse and late-stage failures.
- This setup does not issue billing staff delegation automatically, grant any recipient access, enable financial reads, activate clients, change PA mappings or modify public links. Normal scoped billing delegation and recipient disclosure remain separate reviewed actions afterward.

### Maintenance implementation status (local only)

- Published delegation revision `079fe889f89bbf157e3015301238fbe14af9116b` passed all ten CI jobs in run `38147752087`. That evidence does not cover the newer local maintenance revision.
- The historical Project-organization full-schema fixture initially included migration 0196 despite expecting the frozen 195 ledger. Its exact migration checks correctly rejected that mismatch. The test now explicitly applies through 0195 and asserts the maintenance table is absent; all six full-schema cases passed (587.54 seconds, zero failures/skips). No runtime authorization guard was weakened.
- Forward-only migration `0196_native_directory_maintenance_authority.sql` and a bounded compiler/executor are implemented locally. They add separate approval, immutable receipt and transactional guard tables; existing grant/history triggers remain unchanged.
- The compiler/executor pins the exact staging account, Worker and D1 identifiers. These labels are not proof of the physical database: a future trusted runner must independently verify the provider environment and `OPS_DB` binding before execution.
- The executor never installs approvals or authenticates its own caller. It requires a separately authenticated current native owner and a preinstalled approval matching the plan, issuer and independent identity-verification evidence.
- A usable trusted maintenance adapter is still outstanding. Existing binding-runner configuration checks alone do not establish the live Worker environment or independently authenticate the owner/approval issuer. Existing bootstrap-packet generators must not be repurposed to supply those proofs. The executor currently has no HTTP route or remote runner.
- The canonical real-D1 test passes through all 196 migrations, covering concurrent apply/replay, grant and approval revocation, actor/evidence/issuer drift, current-state and deny changes, collision and late-receipt rollback. Operations type-check passes. Current-chain script checks pass 122 tests (five platform-dependent symlink cases skipped); focused migration checks pass 18 tests. Historical 195 release evidence and the deployed staging baseline remain 195 until a separate verified rollout.
- No maintenance approval or grant has been installed remotely. No billing disclosure, recipient activation, production configuration or public link has changed.
