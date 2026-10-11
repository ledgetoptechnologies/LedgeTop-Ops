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
- Owner UI: 12 desktop/mobile browser checks pass with ordinary clicks, including narrow-screen overflow, denied sessions, review invalidation and identical frozen retries. No forced clicks or skipped mobile cases.
- Operations type-check and final candidate build pass. These checks are not proof of live acceptance.
- Independent read-only review found no concrete issuer/schema/staging-mount regression.

## Remaining release and authority gates

- The existing role/legacy ACL screens do not establish native global directory-management or billing-management grants. A reviewed, usable owner-authorized bootstrap/delegation path is still required. Do not seed billing authority tables or weaken the current issuer guard to make a demonstration pass.
- A read-only staging audit found no qualifying global native directory-management grant or effective billing-management grant for the selected owner. This is an authorization prerequisite, not an authentication failure.
- Publish a fresh reviewed candidate and require successful exact-revision CI. Earlier successful CI for the prior release does not authorize this new source.
- Use a new Ops-first preserved-runtime release profile. Required additions are Ops billing-owner and financial-RPC flags, then Client financial flag and its private financial-reader service binding. Preserve existing flags, bindings, handlers, schedules, container, schema and public links.
- Prove normal owner issuance, recipient PA financial reads, tenant exclusions and same-session revocation in staging. Existing local tests do not prove that live flow.
- Production routing/configuration and the owner PA-update checkpoint remain future gates; this candidate authorizes no production activation.
