# Primary Client Workspace folder bindings

## Purpose

Operations can link a delivery folder to an existing workspace projected by the primary Project Alpha connection. The link supplies routing context for a later authenticated grant. It is deliberately non-authorizing: creating it does not create a public link, login, principal, membership, entitlement, or folder grant.

Public-link sharing remains the default mode in the Share dialog. Staff must explicitly choose **Client Workspace** before this workflow is loaded.

## Authority boundary

Only signed, active `project-alpha:primary` projections are eligible. Operations never searches the raw business snapshot for recipients and never treats an email address as a verified identity.

A binding is accepted only when all of these facts agree:

- the immutable primary source reservation;
- the active native workspace and its exact organization or standalone-client root;
- the active completed directory and portal projection generations at the same source sequence;
- the projected owner entity and its source version;
- the exact Operations folder ownership proof and R2 prefix;
- the selected project when the folder is project-owned.

For an organization or standalone-client root, every explicitly mapped descendant project must resolve to that same projected root and Operations division. Mixed or inferred ancestry fails closed. Folder names and path substrings are never used to guess ownership.

## Staff workflow

When authenticated grants report that a folder is unbound, the Client Workspace tab:

1. Loads eligible targets from `GET /api/delivery/authenticated-grants/binding-targets`.
2. Shows only the exact signed workspace/root supported by the folder ownership proof.
3. Requires staff to select and review the target, including the explicit **Access created: None** result.
4. Creates the link through `POST /api/delivery/authenticated-grants/bindings` with an idempotency key and the reviewed context version.
5. Reloads the existing audience and grant workflow. Access still requires a separate reviewed grant to an exact projected person or an explicit dynamic organization/department audience.

The same idempotency key and request body are reused after an uncertain response. A different request under the same key is rejected. Revocation is version checked, audited, and refused while active authenticated grants still depend on the binding.

## Producer dependency

Project Alpha remains the producer of workspace roots, directory identities, memberships, departments, entitlements, and signed projection checkpoints. Operations can bind only after that producer has published and activated a coherent primary projection. An empty target list is an actionable synchronization state; it is not permission to synthesize a workspace from client records or email addresses.

## Migration and compatibility gate

Client migration `0189_primary_staff_folder_bindings.sql` is mandatory before the Operations build containing these routes is enabled. The migration creates the receipt, mutation, audit, and D1 transaction-fence triggers. It also backfills only coherent pre-0189 primary Operations bindings whose active folder route, signed primary source, directory generation, projection generation, root, and owner all agree. Those rows are marked with the explicit `migration_0189_legacy_compat` reason and are structurally revalidated on every privileged grant context.

An older binding that cannot be proven is deliberately left without a receipt. Operations returns an actionable conflict requiring staff to relink it; it does not silently trust or synthesize authority. Before release, query for active primary Operations bindings without an active receipt and resolve every result:

```sql
SELECT binding.id, binding.workspace_id, binding.r2_prefix
FROM portal_v2_folder_bindings binding
JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
LEFT JOIN portal_primary_staff_bindings receipt ON receipt.binding_id=binding.id AND receipt.state='active'
WHERE binding.source_type='operations' AND binding.status='active' AND binding.revoked_at IS NULL
  AND workspace.project_alpha_source_id='project-alpha:primary' AND receipt.binding_id IS NULL;
```

The result must be empty before enabling authenticated grant mutations. Runtime revalidation suspends a receipt and folder route if Operations ownership or the signed projection changes. Delivery D1 triggers serialize grant insertion with binding revocation: whichever operation wins makes the other fail, so the pre-revoke grant count is never the only fence.

## Verification

Focused D1 tests cover project folders, source-owned client roots, wrong-root/unsigned targets, stale review contexts, runtime suspension, both grant/revoke transaction orders, non-authorizing writes, and replay/revoke fencing. Browser coverage preserves Public link as the default, verifies keyboard selection and review focus, and proves that linking a workspace creates neither a public share nor an authenticated grant.
