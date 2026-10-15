# Native billing authority 0191 review

Status: local draft only. The source is frozen for integration review. Nothing in this slice has been committed, pushed, deployed, or applied to a provider database.

## Proven boundary

Migration `0191_operations_portal_native_billing_authority.sql` adds a dedicated billing authority ledger without rebuilding or widening `native_directory_grants`. It creates no owner, employee, recipient, organization, client, or project grant automatically.

The authority model is explicit and deny-aware:

- management commands issue or revoke exactly one immutable global or resource-scoped billing permission;
- immutable grant and revocation rows preserve the audited management lineage;
- a per-staff billing generation advances independently of the directory-grant generation;
- management admission requires a current authenticated native owner, current admission/profile evidence, a fresh observation, and existing `directory.portal_access.manage` authority;
- billing disclosure commands bind the exact current workspace, recipient enrollment, publication snapshot, entity ownership, actor proof, and billing generation;
- deny rows take precedence over allow rows;
- ACK receipt, post-ACK finalization, and head activation are separate durable stages;
- live authority requires the current actor, lineage, and entity proofs, so later project, workspace, recipient, publication, or billing-authority drift fails closed;
- revoke cleanup uses the exact previously acknowledged frozen grant lineage with a fresh authorized actor and does not reinterpret a changed project as a new grant target.

Supported disclosure entity kinds are exactly `client`, `organization`, and `project`. There are no wildcard, email-match, name-match, inherited-membership, or null-means-all semantics.

## Local acceptance evidence

All commands ran from `apps/operations` in the isolated `financial-response-reader` worktree.

- TypeScript: `tsc --noEmit -p tsconfig.json` passed, terminal execution `e1cc3a`.
- Focused schema/guard suite: `vitest run --config vitest.config.ts test/operations-portal-native-billing-authority-schema.test.ts` passed 6/6 in 58.32 seconds, session `76114`.
- Original canonical portal acceptance after helper extraction: `vitest run --config vitest.config.ts test/operations-native-portal-resource-acceptance.test.ts` passed 1/1 in 117.88 seconds, session `41471`.
- Genuine canonical 0001–0191 billing lifecycle: `vitest run --config vitest.config.ts test/operations-portal-native-billing-authority-fullschema.test.ts` passed 1/1 in 108.58 seconds, session `5927`.

The genuine lifecycle uses the canonical migration and portal fixture rather than the reduced handwritten schema. It proves real directory/project activation, workspace publication, recipient ACK, explicit billing allow issuance, billing grant outbox claim, ACK, receipt, finalization, and head activation. It then performs a real PA project update through POST, ACK, read settlement, and canonical activation; confirms that the old project billing authority disappears; rejects mismatched cleanup; and accepts the exact frozen-lineage revoke.

Historical failed runs were fixture corrections, not passing evidence:

- session `68511` failed because the update fixture returned authorization generation 11, while the production update contract requires equality with the command's expected generation 10;
- after correcting only that fixture response, session `5927` passed.

## Remaining integration work

No additional migration number should be allocated until root integration review. In particular, `0192` is already reserved by the service-definition authority slice and must not be used for billing.

Remaining work is server and Client composition around the reviewed 0191 objects:

1. Add an unmounted server-only billing permission issuer/revoker that atomically composes management command, immutable grant or revocation, and billing-generation compare-and-swap. It must preserve idempotent replay by exact request fingerprint and must not expose a public route by default.
2. Add a private Client RPC that joins the explicit live billing head to the trusted native customer/organization/project mapping resolver and the bounded PA financial HTTP transport. The RPC must recheck recipient, workspace, publication, entity, and billing authority; PA email preferences must not substitute for the Ops billing allowlist.
3. Add the signed-in Client UI for outstanding invoices, contract statuses, and PA-provided public action URLs. It must render only the RPC result, avoid duplicate Ops emails, and leave existing credentials and public-link behavior unchanged.
4. Add joined acceptance covering all three entity kinds, allow/deny/revoke, durable and expiring grants, replay/lost-response behavior, mapping ambiguity, recipient re-enrollment, publication/project drift, and access removal without duplicate PA writes.

## Deployment gates

Before any staging migration, upload, route enablement, or UI acceptance:

- root review and freeze the exact 0191 SQL and tests;
- integrate against the reviewed native 0188–0190 chain and resolve migration numbering without reusing 0192;
- run the full canonical migration chain, focused billing suites, original portal acceptance, TypeScript, source invariants, and the complete CI matrix on one immutable commit;
- review the server-only issuer and Client RPC separately, keeping all routes/default flags off until their authority and transport tests pass;
- verify staging bindings, schedules, feature flags, assets, and source hashes immediately before any one-shot provider mutation;
- rely on the standing staging authorization plus exact-state release gates for migration, upload, and promotion; obtain fresh action-time confirmation only where the executing tool or sensitive browser grant/revocation flow requires it.

This local evidence does not prove a deployed route, live principal access, live PA financial data, or production readiness.
