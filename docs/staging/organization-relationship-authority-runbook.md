# Exact-organization staging authority window

## Status and purpose

- Canonical 0182 release candidate is under verification. It has not been applied to staging. Passing compiler tests alone does not authorize a live apply.
- This is temporary test-operator authority, not recipient enrollment or client file access.
- The target is the fixed synthetic organization in `ORGANIZATION_RELATIONSHIP_TARGET`; the compiler rejects another organization, operator, version, source, or business area.
- Exactly two allow grants are created: `directory.profile.edit` and `directory.identity.link`. Each is resource-scoped to that organization; grant business-area and division columns remain null. No global authority is added.
- Production PA, production Ops, client activation and existing public links are out of scope.

## Preconditions

- Use the exact staging `OPS_DB` binding accepted by the trusted binding runner.
- Before opening a new authority window, the local release and live ledger must both match the explicitly reviewed 182-file name/content pins through migration 0182. During release preparation the live ledger remains at 181; do not open a window using mismatched pins or claim the migration has applied.
- Recheck the live organization version, active resource scope, operator admission/profile, complete grants/history, denies and outstanding work.
- Require passing complete-schema rollback/paired-revoke tests, saved-artifact reconciliation tests and independent review before live use.
- A later PA relationship write still requires its own API permission, server feature gate, current mapping evidence and normal dispatcher acknowledgment. These local staff grants do not bypass those gates.

## Commands

### Parent acknowledgement compatibility gate

- Project Alpha's native create response contains exactly `result.resource` and `result.authorizationGeneration`. The organization bootstrap dispatcher validates that response and independently confirms its profile and binding before storing it unchanged.
- The ordinary profile dispatcher stores those same fields plus the compatibility field `result.data.publicId`. Both are legitimate persisted acknowledgements; an absent compatibility field does not establish corruption or a failed PA connection.
- Relationship consumers must authenticate the exact native shape only for an organization-create acknowledgement, matching the bootstrap producer, or the exact enriched shape used by the ordinary dispatcher. Client creates and profile updates still require the enriched persisted shape. When `data` exists, it must be a singleton object whose `publicId` matches `resource.publicId`. Null, scalar, extra-field, mismatched identity and malformed revision/generation cases remain rejected.
- Preserve all source/application/history, mapping, current local version, command-byte and acknowledged-state checks. Never rewrite immutable receipts to satisfy a consumer assumption.
- Audit the active schema, not every historical SQL occurrence. The correction must cover revision evidence, resolved relationship dependencies, the dependency insert guard and the materialization predecessor guard together. Updating only the revision view leaves later client dispatch or organization profile updates blocked.
- Distinguish immutable historical acknowledgement proof from current-record authority. A predecessor acknowledgement must remain verifiable after its organization's local version advances; that does not make the predecessor the current version. Consumers must still pin the exact command, intent, record, destination and mapping, and independently enforce any required current-version checks.
- In particular, a valid bootstrap mapping must not authorize a new client relationship while the organization's current profile update is still pending or unacknowledged. Require exact current-version acknowledgement evidence as well as the immutable historical mapping proof; test rejection before the update settles and success after its normal dispatcher acknowledgement.
- The canonical `0182` candidate and runtime correction require regression tests and independent review before staging application. The retained local proposal is compared with the canonical SQL statements; historical tests explicitly retain their pre-0182 boundaries. Test actual organization bootstrap acknowledgements, ordinary enriched acknowledgements, updates and negative shapes; consumer fixtures alone do not prove the full producer path.
- Do not open temporary authority until the parent evidence passes. If organization and fresh client-area windows overlap, open the organization first and the area second, settle all normal work, then close the area first and organization last. The area close verifies its original non-packet grant snapshot.

### Forward migration release order

- Review the final proposal and runtime together, including actual bootstrap persistence, ordinary dispatcher persistence, operation-crossed shapes and malformed identities. Exercise bootstrap → organization profile update/acknowledgement → linked-client creation/dispatch with the full canonical schema and triggers enabled. A passing seeded consumer fixture is not a substitute for producer tests.
- Promote only the reviewed forward SQL object replacements and validation view to the canonical migration chain. Recompute complete name/content hashes from LF bytes and explicitly advance every migration-profile, bootstrap, authority and recipient-readback pin. Preserve historical cutoff tests; never rewrite an already-applied migration.
- Run the affected complete-chain, authority rollback/revoke, migration-profile determinism, dispatcher, relationship and type-check gates before exact-revision CI. Keep temporary authority closed throughout this release preparation.
- Before a staging apply, save and verify a private database backup and inspect the exact current migration ledger. Apply only the reviewed next migration, then verify the complete ledger, exact reviewed view/trigger definitions, unchanged non-target schema, foreign keys and absence of unexpected grant changes.
- Validate complete SQL execution in local adapters: the pinned Wrangler splitter may return a chunk containing a trigger followed by additional statements. `node:sqlite.prepare` executes only the first statement in such a chunk, so it is not equivalent to D1 migration execution. Local SQLite schema setup must execute the complete script, and the resulting schema must include all seven reviewed changed/new objects. The remote Wrangler migration path sends the complete migration plus ledger insert to D1; independently verify the resulting live schema rather than assuming parser output proves application.
- Upload and promote the matching reviewed runtime separately, preserving staging bindings, settings and schedules. Neither migration success nor deployment success proves live relationship or portal acceptance; those tests follow through normal application flows.

Run from the authoritative Operations worktree. `<config>` is a private minimal staging binding configuration, not a production configuration.

```powershell
node scripts/staging-organization-relationship-authority-window.mjs prepare --config <config>
node scripts/staging-organization-relationship-authority-window.mjs apply --config <config>
node scripts/staging-organization-relationship-authority-window.mjs close --config <config> --artifact <private-provision.json>
node scripts/staging-organization-relationship-authority-window.mjs reconcile --config <config> --artifact <private-phase-artifact.json>
```

- `prepare` is read-only. Do not publish its complete snapshot or artifact output.
- `apply` must save private evidence before the atomic D1 batch and independently verify the resulting authority.
- `close` uses the exact saved provision artifact and removes only its original two grant IDs; it must not substitute another pair.
- `reconcile` is read-only. Use the exact saved phase artifact after an uncertain response, including an uncertain close. A receipt alone is insufficient without the corresponding approval and exact authority state.
- If reconciliation remains unknown, preserve the private evidence and investigate. Do not retry with new grant IDs or assume cleanup succeeded.

## Cleanup and evidence

- Approval expiration is not automatic grant removal. Perform and verify the paired close explicitly.
- Keep the private provision/revoke artifacts, immutable approval/receipt readbacks and exact before/after evidence outside Git.
- Record sanitized test results and whether paired cleanup completed in the portal acceptance checkpoint. Do not record credentials, bearer URLs or customer snapshots there.
- Do not call staging sync or client-portal acceptance complete until the normal relationship command is acknowledged and recipient browse/denial/revocation tests pass separately.
