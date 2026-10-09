# Exact-organization staging authority window

## Status and purpose

- Local proposal under review. Passing compiler tests alone does not authorize a live apply.
- This is temporary test-operator authority, not recipient enrollment or client file access.
- The target is the fixed synthetic organization in `ORGANIZATION_RELATIONSHIP_TARGET`; the compiler rejects another organization, operator, version, source, or business area.
- Exactly two allow grants are created: `directory.profile.edit` and `directory.identity.link`. Each is resource-scoped to that organization; grant business-area and division columns remain null. No global authority is added.
- Production PA, production Ops, client activation and existing public links are out of scope.

## Preconditions

- Use the exact staging `OPS_DB` binding accepted by the trusted binding runner.
- The canonical migration chain must match the reviewed 181-file name/content pins. Do not silently repin this tool when adding migration 0182.
- Recheck the live organization version, active resource scope, operator admission/profile, complete grants/history, denies and outstanding work.
- Require passing complete-schema rollback/paired-revoke tests, saved-artifact reconciliation tests and independent review before live use.
- A later PA relationship write still requires its own API permission, server feature gate, current mapping evidence and normal dispatcher acknowledgment. These local staff grants do not bypass those gates.

## Commands

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
