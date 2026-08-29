# Operational contacts, project memory, and selective copy-forward

Status: incrementally implemented and locally verified through migration `0047`.
Project contacts, fixed-section Project Memory, selective copy-forward, and
manager-only private staff-upload attachments now exist. Crew contribution,
client attachment access, attachment copy/delete, and attachment notifications
remain deliberately unimplemented. See the
[staff attachment runbook](project-memory-staff-attachments.md) for the exact
storage, authority, recovery, and rollout contract.

This document complements [the client-workspace roadmap](client-workspace-roadmap.md),
not replaces it. Organization and project contacts, multiple site contacts, rich
field notes, historical memory, selective recurrence, and a field-friendly crew
view remain in scope for the roadmap. Deferring a capability below does not mean
it has been dropped.

## Existing authority and reusable implementation

### Operations permissions

- `packages/shared/src/index.ts` defines `projects.view` and
  `operations.manage`, but no `projects.manage`, `project.notes.write`, or
  operational-contact management permission.
- `apps/operations/migrations/0005_project_alpha_ops_acl.sql` removes
  `operations.manage`, `tasks.create`, and `tasks.update` from the default
  operator, division-manager, and delivery-coordinator roles. The older seed in
  migration `0002` is not the final role policy.
- `apps/operations/src/worker/index.ts` defaults staff mutations to an
  administrator gate and enforces same-origin/CSRF protection. The narrow
  exceptions are enumerated in `r2-crud-validation.ts`.
- Job Brief writes are one such exception: `job-brief.ts` first verifies the
  exact active operation through `operations.view` and its assignment predicate,
  then requires `operations.manage` in the operation's actual division/assigned
  staff context. Assignment alone never supplies that permission.
- `acl.ts` honors applicable explicit denies. Calling `hasPermission` without a
  resource context is not sufficient to authorize a resource-scoped write.
- `work-context-sops.ts` already distinguishes project visibility from a narrower
  management assignment: operation/task assignment can establish project read
  visibility, while its management context contains the project manager and
  direct project assignments. Its authoritative SQL evaluates live grants and
  assignments in the same statement/batch as protected reads or mutations.

There is no current precedent for ordinary assigned pilots editing Job Brief
text or uploading its attachments. `job-brief-route.test.ts` explicitly expects
`403` for those writes and `canEdit: false` for the assigned pilot. The separate
`sops.assign` exception permits SOP pin selection only, not general note editing.
Neither `team.manage`, `delivery.files.copy`, nor `sops.assign` should be reused
as a general project-memory write permission.

Client Hub additionally requires global `team.view`. Its
`client-hub-project-policy.ts` adds project visibility and live assignment checks;
it does not grant project mutation. The eventual field-crew workflow should use
a separately authorized operation/project route, not require granting a pilot
global client-directory access.

### Job Briefs and historical data

`0017_operational_job_briefs.sql`, `job-brief.ts`, and `JobBriefPanel.tsx` provide:

- an operation-owned current snapshot and optimistic integer version;
- immutable full revision snapshots and successful-change audit events;
- private staff uploads and authorized project-file references with pinned ETags;
- private, operation-authorized attachment delivery;
- conflict reporting and dirty-editor protection during best-effort refresh.

Migration `0020_internal_sop_library.sql` adds exact published SOP revision pins.
These patterns should be reused, but an operation brief must not be relabelled
as a project-wide memory record: its parent, authorization, and attachment URLs
are operation-specific. The current brief history lists revision metadata; it
does not expose a general historical-snapshot reader or copy-forward endpoint.

Brief access checks source presence (`active=1`), not whether the operation is
`completed` or `cancelled`. Its current snapshot can receive authorized revisions
after completion; past revisions remain immutable. There is no existing
completed-project notes lock to inherit.

### Project Alpha ownership

The inspected Alpha producer is in `src/services/OpsSnapshotService.php` in the
separate Project Alpha repository. Alpha owns these business records:

- `clients`: named contacts/standalone clients, scalar email/phone, and current
  organization membership;
- `organization_department_contacts`: department membership, a role field, and
  primary-contact designation;
- `project_clients`: project contacts, a role field, primary-billing designation,
  invoice-email selection, and invoice-link visibility;
- `organizations.general_email` and `general_phone`: general company channels,
  distinct from a named person;
- project identity, ownership, status, schedule, assignments, and financial
  lifecycle.

Relevant producer evidence includes `database/baseline.sql`, migration
`0071_organization_general_contacts.sql`,
`src/controllers/organization/organization_departments.php`,
`src/controllers/project/projects_create.php` and `projects_update.php`, and
`src/utils/project_invoice_billing.php`.

The current Ops snapshot exports clients' scalar email/phone and the project's
`client_id`, but not the department/project-contact role collections,
organization general channels, or project notes. Missing projection is not proof
that those source records are empty. The project's `client_id` participates in
Alpha's primary-billed-client workflow; it must not be inferred to mean site
contact, organization primary contact, delivery recipient, or portal identity.
Read-only presentation should name its exact source relationship.

Alpha's `ProjectCloseGuardService` owns terminal project status transitions and
their financial guards. Saving Ops-owned observations must never reopen, close,
or otherwise mutate that Alpha lifecycle.

## Proposed incremental contract

### 1. Read and navigate before adding writes

Provide a canonical, source-aware business-project detail route from Client Hub.
Use the same exact root ownership and live project permissions as business
history, before and after hydration. Return whitelisted project/contact fields,
not `pa_projects.*` or arbitrary source payloads. Distinguish unavailable or
unprojected contact roles from a verified empty collection.

Preserve refresh/back navigation and the client-directory return context.
Present business contact channels as contact information only; they confer no
login, grant, notification subscription, or invitation.

### 2. Explicit operational roles and versioned memory

Add Ops-owned role assignments and project-memory records separately from the
read-only Alpha projections. Key them by immutable connector/source identity
and exact source project/contact references. Do not infer equivalence from name,
email, numeric ID coincidence, or portal membership. Initially support only the
configured producer; adding a second producer still requires source-isolation
acceptance, not merely a new source label on the UI.

Operational role assignments should support multiple project/site contacts,
preferred contact method, and arrival instructions. Reuse existing Alpha
contacts first. Alpha-owned name/email/phone edits and financial recipient flags
stay in Alpha. An Ops-local operational role must be distinguishable from an
authoritative Alpha billing/department role; it cannot silently change billing,
delivery, or access behavior.

Memory retains separately understandable sections for plan, actual
outcome, deviations/reasons, observations, problems, successes, recommendations,
and requests for next time. It uses a versioned current record with immutable
revision content, actor, timestamp, and provenance. Text is the first useful
increment; private images, screenshots, PDFs, annotation authoring, SOPs, and
other field material remain explicit subsequent increments. Migration `0047`
adds private manager-only JPEG, PNG, WebP, GIF, TIFF, and PDF uploads without
turning them into project files, portal assets, or copy-forward inputs.

The implemented write boundary is an administrator with effective global
`project.memory.manage` plus verified project visibility. If delegated writes
are approved, add a purpose-specific permission and a
narrow route exception, using an actual project management context. Do not
derive write access from `manager_user_id` or assignment alone.

### 3. Selective copy into an existing destination

The initial copy operation should target a separately existing, verified project.
It must not claim to create an authoritative Alpha project. A later
`Create Next Occurrence` workflow can use an approved Alpha write contract or
real authorized Alpha navigation, then populate independently editable Ops data.

A proposed copy request identifies:

- exact source identity/project and immutable revision;
- explicit selected sections/items/contact assignments;
- exact destination identity/project and expected destination version;
- an idempotency key for the same logical copy attempt.

The preview must show what will be copied and what will remain untouched.
Prefer adding selected content into a reviewed destination, not replacing its
entire current memory. Assign new destination record IDs and retain provenance
to the source revision/items. The source must not change.

Require source read permission and destination write permission separately.
Default to the same producer and same live client/organization owner. Recheck
both ownership relationships and each selected contact's current membership at
commit. Moved, deleted, or unavailable contacts require review; never follow
them automatically into another client's workspace.

Commit the guarded destination mutation, immutable revision, idempotency result,
and audit event together. Reject stale destination versions, changed ownership,
unavailable source revisions, or invalid selections without partial writes.
For non-database attachment work, use staged immutable objects with cleanup on
failed commit and never remove an object referenced by a successful commit.

Never copy permissions, grants, invitations, identity links, billing flags,
invoices, completion state, pending notices, or implicit notification recipients.
Reusing a historical instruction is not permission to share its source assets.
Do not copy old operation-specific attachment URLs into the destination.
Attachment reuse needs a destination-authorized immutable object/reference,
explicit provenance, and a retention policy; external file references can become
unavailable if their pinned content changes. SOP copying must likewise check
current authority and make historical versus current revision selection explicit.

## Product decisions still open

1. **Crew contributions:** may assigned staff append their own observations, or
   are all edits manager-only? If staff can contribute, can they edit another
   person's observations or the original plan? An optional question is pending;
   no answer must be inferred as permission to broaden writes.
2. **Project-specific people:** must every named person first exist in Alpha, or
   may Operations hold a clearly local, project-only site contact? A local person
   must not automatically become an Alpha client or portal identity.
3. **Organization roles:** which operational primary/delivery roles are Ops-owned,
   and which should be projected from Alpha? Actual financial recipient settings
   remain Alpha-owned regardless of operational labels.
4. **Cross-client templates:** should copying be restricted to the same customer,
   or may an authorized manager deliberately copy sanitized instructions between
   customers? Source read plus destination write alone does not settle this
   disclosure policy. Same-customer-only is the conservative starting point.
5. **Completion:** allow audited revisions/annotations after completion, or seal
   the record and require an explicit amendment? The handoff requires post-job
   memory and unchanged historical jobs; it does not specify a seal/reopen rule.
   Either design must leave historical revisions and Alpha status unchanged.

## Acceptance scenarios

- A contact is moved or deactivated between selection and save: no cross-owner
  assignment or stale-contact copy is committed.
- Identical IDs in different source namespaces remain unrelated.
- A user can read the source but cannot edit the destination, or loses an
  assignment during the request: deny with no revision, object leak, or audit
  event claiming success.
- An assigned pilot can read their operation brief but cannot gain notes-writing
  or global directory access from that assignment.
- A completed project receives permitted post-job documentation without changing
  its status, invoices, or previous revisions.
- Two editors save the same version: one wins; the other keeps their draft and
  sees an explicit conflict. Retrying an uncertain copy produces one result.
- Selective copying leaves excluded fields and existing destination content
  intact; later destination editing cannot alter source history.
- Copying does not create grants, send mail, expose billing links, or transfer
  source-only attachments. Unauthorized source bytes remain unavailable.
- Mobile users can find site contacts, contact instructions, maps, and notes;
  Back/Forward and refresh retain the selected project; dirty drafts are not
  silently discarded by navigation or background refresh.

Regression foundations are `apps/operations/test/job-brief-route.test.ts`,
`apps/operations/test/browser/job-brief.spec.ts`, the Client Hub project/history
tests, and Alpha's `InvoiceContentLinksTest` and `ProjectWorkflowUiTest`. Extend
these with real populated-migration and scoped mutation tests before release;
passing current read-only tests does not verify the proposed write contract.
