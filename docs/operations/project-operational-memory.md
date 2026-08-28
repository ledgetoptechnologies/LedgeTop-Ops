# Project operational contacts and memory

Status: backend contract implemented; route and UI integration intentionally deferred.

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

The root recorded with an overlay must exactly match the current Client Hub root. Reads validate contact and memory metadata before fetching instructions, snapshots, or revisions; saves validate it before mutation. If Project Alpha reassigns a project, Operations returns an ownership-changed conflict and releases no old overlay content. This slice intentionally does not transfer or erase that history. A future administrator workflow must make reset/transfer explicit, preview the old and new opaque roots, require a reason and idempotency key, and append a non-PII audit event before the overlay can be used under the new owner.

## Versioning, retries, and audit

Both overlays use monotonically increasing optimistic versions. Writes require the Client Hub context version and current overlay version. A caller-generated idempotency key is scoped to the staff actor; an exact retry returns the original result without another revision or audit event. Reusing a key for different input fails.

Contact and memory revisions, audit events, and mutation receipts are immutable. Database checks bound revision payloads to 512 KiB for contact snapshots and 128 KiB for memory snapshots. Audit detail contains only schema version and bounded counts; it never contains source-controlled status, names, contact channels, instructions, memory text, or amendment reasons.

Completed or cancelled projects remain amendable because operational history sometimes needs correction. Such a memory write requires a non-empty amendment reason and creates a `post_completion_amendment` revision. It does not reopen or mutate the Project Alpha project.

## Integration surface

`apps/operations/src/worker/project-operational-memory.ts` exports validation schemas, types, and pure service functions ready for staff-authenticated routes:

- `readProjectOperationalWorkspace`
- `saveProjectOperationalContacts`
- `saveProjectMemory`

Route handlers must create a current `ClientHubCollectionContext`; they must not accept a source, root, or permission result from browser input. The first UI should expose the two operational roles and the fixed text sections in the existing business-project detail workspace. Attachments, automatic recurring-project copy-forward, portal exposure, and Project Alpha writes are deliberately out of scope for this slice.

## Verification

`apps/operations/test/project-operational-memory.test.ts` applies the real migration chain to populated D1, verifies no inferred rows or authority changes, exercises exact-root assignments and memory amendments, proves idempotency and schema-enforced immutable history, rejects invalid contacts and stale versions, validates exhausted-fence and actor-mismatch defenses for the service protocol, and injects an authoritative root change immediately before the official mutation batch to prove its atomic rollback behavior.
