# Project operational contacts and memory

Status: backend contract and staff project-workspace integration implemented locally; publication and live acceptance remain pending.

## Authority boundary

Project Alpha remains authoritative for client and organization records, projects, project lifecycle, billing, portal access, account roles, recipients, and notifications. Operations stores only two staff-facing overlays on an exact projected project:

- operational assignments using the fixed `project_contact` and `site_contact` roles;
- a structured text snapshot for plan, outcome, deviations, observations, problems, successes, recommendations, and next-time requests.

An operational assignment does not grant portal access, change a billing contact, subscribe anyone to notifications, or change an account or project role. Contacts must be active `pa_clients` from the same projection source and exact owning organization (or the exact standalone-client root). Arbitrary people, cross-source matches, fuzzy names, email matches, and inferred relationships are rejected.

## Permissions and live policy

The migration adds `project.contacts.manage` and `project.memory.manage`. Only `role-owner` and `role-admin` receive them by default. Reading still requires the existing global `team.view` and `projects.view` policy and exact Client Hub root/project visibility.

Every mutation rechecks, inside the same D1 batch:

- active staff and the purpose-specific permission, including explicit global denies;
- live Project Alpha source visibility;
- active exact root and its source revision;
- project ownership, policy visibility, status, source revision, and optimistic version;
- active exact-root membership for every assigned contact.

The shipped service creates the write fence, performs every domain write, records the receipt, and removes the fence in one atomic D1 batch. A database view revalidates the recorded facts for each protected service stage. This is defense in depth against bugs or accidental table writes that do not follow the service protocol.

Each fence carries counters for the expected current-row write, old-assignment deletes, new-assignment inserts, revision, audit event, and mutation receipt. Protected triggers consume those counters in the service's expected order and require stored `created_by`, `updated_by`, and `actor_id` values to match the service fence actor. The focused tests prove that an exhausted fence from this protocol is rejected if accidentally reused and that mismatched actor fields are rejected under a prepared fence.

These controls do **not** prove transaction provenance and are not a security boundary against an actor or process with arbitrary D1 write access. The Operations D1 binding, migration runner, and administrators with direct database access are trusted. No other application module may write the `project_operational_*` tables or construct/update fence rows; all product writes must call the exported service functions. A writer with arbitrary SQL could construct or alter matching fence state and is outside this model.

The root recorded with an overlay must exactly match the current Client Hub root. Reads validate contact and memory metadata before fetching instructions, snapshots, or revisions; saves validate it before mutation. If Project Alpha reassigns a project, Operations returns the typed `project_operational_recovery_required` conflict and releases no old overlay content. Non-administrators receive a contact-admin state. An administrator with deny-aware global project contact and memory permissions must choose reset or transfer, enter a reason, preview the exact current context, and type the action-specific confirmation. The commit is atomically fenced to the source, project revision, root revision, overlay versions, permissions, preview fingerprint, and idempotency key, and writes an immutable non-PII receipt.

Both recovery modes clear operational contact assignments and start contact history at the clearing revision. Reset writes an empty structured-memory revision and moves earlier revisions into the immutable recovery archive; transfer preserves the structured memory and its active history. Both modes move prior-root attachment metadata and its upload audit/receipt provenance into immutable, non-routable recovery archives before removing those rows from active tables. The R2 objects remain retained under their original keys for administrative recovery. This database boundary keeps pre-`0052` Workers from enumerating old-owner filenames, media types, or sizes after rollback. Recovery never copies or infers contacts, attachments, access, billing, notifications, identities, recipients, grants, or Project Alpha records. Retry an ambiguous response with the same operation key and unchanged command. A stale source, root, project, ownership, permission, or preview returns a conflict and requires a fresh preview.

Before release, apply migration `0052` before the Worker update, run the project operational migration/service/route/browser suites, and verify both a populated upgrade and a fresh database. Do not manually update recovery receipts or fences. Investigate a `503` as corrupt/mixed historical state rather than bypassing the guard.

## Versioning, retries, and audit

Both overlays use monotonically increasing optimistic versions. Writes require the Client Hub context version and current overlay version. A caller-generated idempotency key is scoped to the staff actor; an exact retry returns the original result without another revision or audit event. Reusing a key for different input fails.

Contact and memory revisions, audit events, and mutation receipts are immutable. Database checks bound revision payloads to 512 KiB for contact snapshots and 128 KiB for memory snapshots. Audit detail contains only schema version and bounded counts; it never contains source-controlled status, names, contact channels, instructions, memory text, or amendment reasons.

Completed or cancelled projects remain amendable because operational history sometimes needs correction. Such a memory write requires a non-empty amendment reason and creates a `post_completion_amendment` revision. It does not reopen or mutate the Project Alpha project.

## Integration surface

`apps/operations/src/worker/project-operational-memory.ts` exports validation schemas, types, and pure service functions used by the staff-authenticated project routes:

- `readProjectOperationalWorkspace`
- `saveProjectOperationalContacts`
- `saveProjectMemory`

`apps/operations/src/worker/project-operational-routes.ts` creates the current `ClientHubCollectionContext` server-side for every read and save. It never accepts source ownership, root ownership, permissions, or contact candidates from browser authority. Its GET returns the operational overlay with an exact-root `businessContacts` page of 25 records; continuation uses the existing context-bound collection cursor and another bounded page. The two POST routes pass the request body to the service schemas unchanged and recheck the live Client Hub context after the operation.

`apps/operations/src/client/ProjectOperationalWorkspace.tsx` presents the overlay in the existing exact-source business-project workspace. Staff can explicitly edit or cancel:

- `project_contact` and `site_contact` assignments chosen only from the progressively loaded exact-root projected contacts;
- preferred contact method and bounded operational instructions;
- all eight structured project-memory sections;
- an audited amendment reason when the current source project is completed or cancelled.

There is no auto-save. Each explicit save receives a new idempotency key, while an exact retry after a transient failure reuses that key and preserves the draft. An ownership/context `409` clears the whole project workspace; transient failures remain local. Revision lists show version, time, change kind, and amendment reason without displaying raw staff actor IDs. All interactive controls have a 44-pixel minimum target and collapse to a single-column mobile layout.

Private staff attachments are supported through the separately reviewed project-memory attachment contract. They remain Operations-owned, append-only project evidence; they are not exposed in the client portal and do not create access, recipient, billing, or notification authority. Project Alpha writes remain out of scope for this slice.

## Verification

`apps/operations/test/project-operational-memory.test.ts` applies the real migration chain to populated D1, verifies no inferred rows or authority changes, exercises exact-root assignments and memory amendments, proves idempotency and schema-enforced immutable history, rejects invalid contacts and stale versions, validates exhausted-fence and actor-mismatch defenses for the service protocol, and injects an authoritative root change immediately before the official mutation batch to prove its atomic rollback behavior.

`apps/operations/test/project-operational-routes.test.ts` verifies server-side context resolution, bounded contact continuation, stale/unauthorized rejection, unmodified expected-version and idempotency bodies, post-read context races, and unsupported source/namespace rejection. `apps/operations/test/browser/business-project-workspace.spec.ts` covers explicit saves, exact role payloads, terminal amendment validation, no authority fields, retry-stable idempotency, draft preservation, whole-workspace conflict invalidation, refresh races, and desktop/mobile layouts.
