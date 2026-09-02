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

## Verification

Focused D1 tests cover project folders, source-owned client roots, wrong-root/unsigned targets, stale review contexts, non-authorizing writes, and replay/revoke fencing. Browser coverage preserves Public link as the default and proves that linking a workspace creates neither a public share nor an authenticated grant.
