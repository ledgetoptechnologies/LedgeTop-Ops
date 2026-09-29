# Client proposed-project approval plan

## Purpose and boundary

This is an implementation blueprint for one end-to-end outcome: a client can
submit a service request with no project, an already-authorized existing
project, or a **proposal for a new Project Alpha (PA) project**.  A qualified
staff member may then either create one PA project from that proposal or link
the request to one explicitly selected existing PA project.  It is not a new
generic proposal DTO and it does not authorize portal access, Delivery,
Viewer, pricing, recipient disclosure, or a Project Alpha connection.

This document proposes no runtime, schema, authorization, or flag change.
The current recipient-binding workflow remains approval-pending; this work
must not treat an onboarding recipient binding as a project/request grant.

## Current evidence and what it can be reused for

| Existing component | Evidence | Reuse in this slice | Does not provide |
| --- | --- | --- | --- |
| Client request drafts/submission | `apps/client/src/worker/client-portal/request-v2.ts`: `createServiceRequestDraft`, `saveServiceRequestDraft`, and `submitServiceRequestDraft` validate current catalog/assignment/authority and write request, revision, notification and audit in one `database.batch`.  The submitted request accepts `project_id=NULL`. | Client-owned draft, expected-version CAS, request idempotency/fingerprint, immutable request-thread event, notification/audit patterns. | A proposed-project choice, immutable proposal revisions, staff approval, PA command, or link. |
| Client HTTP gate | `apps/client/src/worker/client-portal/routes.ts` `/service-requests` requires same origin, rate limiting, `Idempotency-Key`, bounded JSON and root/project `request.create` authorization. | Same-origin/idempotency/rate-limit and exact root-versus-project authorization conventions. | Authority to create/link PA projects. |
| PA v2 command producer | `apps/operations/src/worker/project-alpha-project-v2-command-producer.ts`, `planProjectAlphaProjectV2Command`. | Exact canonical command hash, destination/source pins, current staff admission/profile/generation proof, local-head/mapping guard, one local outbox/reservation/fingerprint/event/intent batch. | A staff review UI/route, proposal state transition, or cross-database transaction with Client DB. |
| Existing-PA adoption review | `project-alpha-project-adoption-review-producer.ts`, `project-alpha-project-adoption-review-consumer.ts`, and `project-alpha-project-adoption-bind-consumer.ts`. | Independently read PA detail/binding/inventory, pin source instance/application/history epoch, exact review evidence, reviewer replay checks, and bind command planning. | Permission to select an arbitrary PA project or a durable relationship from a client request to it. |
| Dispatch and settlement | `project-alpha-project-v2-pending-dispatcher.ts`, `project-alpha-project-settlement-adapter.ts`, `project-alpha-project-canonical-activation-adapter.ts`; migrations `0119`, `0120`, `0122`. | Leased delivery, exact PA acknowledgement receipt, durable no-body evidence, settlement and canonical activation. | Atomicity across Client DB, Ops DB, and PA; portal/delivery publication. |

The existing producer has an important eligibility distinction that the new
planner must preserve. `create` requires both the local
`operations_shared_projects` head **and** `project_alpha_project_mappings` to
be absent. `bind` instead requires an existing unmapped native head with the
exact expected version/projection. Do not pre-create an Ops head merely to
make a proposal: that makes `create` stale/blocked. An existing PA project is
therefore an adoption/bind path, not a fake create.

There is a second current limitation: the create producer's `directoryReady`
requires a non-null `organizationRecordId`, although the PA create command can
have a null client. This plan therefore supports a proposed create only when
the client request is rooted in one explicitly mapped, current organization;
it must not manufacture an organization from a display name or select one by
similarity. A personal-client/no-organization proposal is not covered until a
reviewed PA/API and native-directory model supports it.

`D1Database.batch()` is atomic only for statements in that one D1 database;
it is not a transaction across Client D1, Ops D1, or PA. This is also the
documented D1 contract: [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

## Proposed domain model and contract

### Client request project choice

At draft creation/update, record exactly one discriminated choice, validated
server-side against the current session and the draft's expected version:

| Choice | Stored request context | Required current proof |
| --- | --- | --- |
| `none` | no `project_id`; no proposed-project reference | root `request.create` authority |
| `existing` | current authorized local `project_id`; retain any independently verified source-qualified PA mapping | exact active project `request.create` grant; no browser-supplied PA identifier is trusted; do not require PA availability for a native request |
| `propose` | `proposal_id`, immutable initial proposal revision; no PA project ID | root `request.create` authority plus the same account/workspace/identity fence as the draft |

The proposal is an immutable, request-owned record. It holds client supplied
scope/name/description/dates/organization-client context only after bounded
validation; each client edit appends a revision rather than updating the prior
snapshot. The submitted request pins `proposal_id` and `proposal_revision`.
Staff decisions must name that revision, preventing silent approval of later
client edits. The authoritative local and PA IDs are stable opaque IDs; a
human-friendly name is copied only as an immutable snapshot and is never a
join key.

`draft` may be discarded only while it is unused: no request submission, no
proposal revision pinned by a submitted request, no staff decision/command
handoff, and no external PA receipt. A submitted request, proposal revision,
decision, command ID, receipt, or link is durable history and is never erased
by “discard.”

### Staff decision command

Provide one native-staff-only action with a request ID, expected request
version, proposal revision ID, idempotency key, and exactly one decision:

* `create`: staff enters the bounded PA-create fields derived from the pinned
  proposal revision. The server constructs the canonical PA create command;
  it does not accept a client-created command body.
* `link`: staff supplies exactly one PA project public ID from the configured
  selected source. Server obtains independent current PA detail, binding and
  inventory evidence, requires one exact inventory match, and creates the
  existing adoption-review/reservation/bind sequence. A fuzzy name match,
  a client-supplied existing ID, or “first matching project” is denied.

The response is a durable decision/handoff receipt, not an assertion that PA
has completed. It returns stable IDs, decision state, request/proposal
versions, command/reservation ID, source identity pins, and a non-sensitive
retry disposition. Never return PA headers, response bodies, credentials,
recipient bindings, or portal links.

## End-to-end state and recovery

1. Client saves a CAS/versioned draft and selects `none`, `existing`, or
   `propose`. Submission uses the existing request idempotency protocol. For
   `propose`, the request pins an immutable proposal revision and starts
   `awaiting_staff_project_decision`; it does not create a project.
2. A native staff reader lists only requests within its independently derived
   scope. It shows the pinned snapshot and status, never an unpinned “latest”
   proposal as approval input.
3. On decision, re-read request/version/proposal pin, active client/request
   authority, staff admission/profile, role, effective allow/no-deny scopes,
   staff grant generation, directory mappings/relationship, configured PA
   connection identity, and (for link) PA independent evidence. Persist the
   staff decision/idempotency receipt and an **explicit durable handoff**.
4. A resumable Ops worker consumes that handoff and calls the existing create
   producer or adoption/bind producer. It records the produced command or
   reservation ID back to the handoff with CAS. The command producer itself
   rechecks current actor admission/profile/generation and all local/source
   pins before reserving the outbox command.
5. The existing dispatcher leases and sends exactly that command. A timeout or
   ambiguous response is `uncertain`, retaining the exact command ID/hash for
   receipt recovery; it must never create a fresh command on retry. A validated
   PA acknowledgement produces durable receipt evidence; settlement and
   canonical activation occur through their existing guarded stages.
6. Only after the matching receipt plus canonical activation does a local
   projector CAS the request decision from `pending` to `created` or `linked`,
   writing the exact PA source/instance/application/history-epoch/public ID,
   PA revision, local external project ID, command ID and receipt ID. It must
   reject a receipt for another command, proposal revision, source pin, or
   request version. Replaying the decision returns that same terminal link.

The proposal decision and producer call cannot be made one transaction by
putting two `batch()` calls next to each other. The minimum safe design is a
durable handoff/outbox with a unique decision-to-command relation, idempotent
consumer, compare-and-set transitions, and reconciliation for a crash between
the Client-side decision record and the Ops command reservation. A reviewed
shared-statement refactor could reduce a same-Ops-DB boundary later, but must
not be assumed atomic today.

## Authority and visibility rules

* Client submits only with current exact root/project `request.create`; an
  optional project does not convert root authority into project authority.
* Staff needs a dedicated native request-review/project-approval permission,
  active admission, native profile match, required owner/manager role as
  decided by policy, applicable allow for every directory scope and no
  applicable deny. Cache-free rechecks pin admission version, profile version,
  access subject, permission/grant generation and normalized scopes into the
  decision/handoff. Recheck again at command production and dispatch. Approval
  permission does not replace the existing native create/bind permissions or
  the bound PA credential's corresponding scopes.
* Pin PA `sourceId`, source instance ID, application ID, history epoch,
  destination origin, public ID, revision, projection SHA-256 and PA
  authorization generation. The existing adoption producer demonstrates this
  evidence standard; a stale/changed generation must block rather than reuse
  prior evidence.
* A matching PA receipt activates only the request-to-project mapping. It does
  **not** create a client portal workspace grant, Delivery grant/subscription,
  Viewer association/share, account membership, recipient binding, or access
  to a project. Those each retain their own explicit workflow and receipt.
* Revoking client request authority before submission denies it. Revoking staff
  authority, changing generation, expiring proof, stale proposal revision, or
  a changed source/directory mapping before command reservation blocks the
  handoff. After an irreversible PA receipt, do not pretend it was undone:
  mark the local request as `reversal_required` and require a separately
  authorized PA/local reversal command with its own receipt and audit.

The current onboarding recipient binding deserves special treatment: it is a
separate active/unexpired identity-to-client record used by the default-off
authority bridge (for example
`apps/operations/src/worker/client-portal-authority-v3-owner-http.ts`). Its
staff-facing issuance/approval path remains pending. This plan neither
requires it nor permits it to satisfy project approval, client request, or
portal/delivery visibility.

## Minimal implementation seams

1. Add request/proposal storage and client endpoint/UI only after a contract
   review: discriminated choice, immutable revisions, request pin, expected
   version/idempotency, and append-only audit. Reuse `request-v2.ts` guarded
   draft/submit batch style; do not loosen legacy `repository` paths.
2. Add a native staff review read/decision route beside the existing native
   Operations HTTP adapters. It must derive staff identity server-side and
   use a new explicit permission, never a Client session, legacy staff session
   fallback, `account.displayName`, or a generic Client Hub capability.
3. Add an Ops-only durable handoff/consumer. Invoke
   `planProjectAlphaProjectV2Command` for create and the adoption
   review/reserve/bind functions for link. Preserve their exact create/bind
   eligibility; do not wrap their independent D1 batch in a claimed global
   transaction.
4. Add a receipt-to-request projector/reconciler. It consumes canonical
   activation receipts rather than raw transport success and is idempotent by
   decision/command/receipt tuple. Keep feature flags default-off and do not
   add delivery/portal side effects.

## Acceptance matrix

| Case | Required result |
| --- | --- |
| Positive propose/create | authorized client submits pinned proposal; authorized staff approves current revision; one exact command, PA receipt, activation, and request mapping result |
| Positive existing/link | staff explicitly selects one inventory-proven PA project; adoption/bind receipt maps one request to that project |
| Optional none | root-authorized request submits without a proposal or project and never creates one implicitly |
| Denied client | wrong account/identity, revoked member, missing root/project request grant, stale draft version, or client-supplied PA ID is hidden/denied with no decision/outbox row |
| Denied staff | inactive/changed admission/profile, deny override, changed grant generation/scope, wrong source, stale directory relationship, or expired PA evidence creates no command |
| Duplicate | same client submit/decision idempotency key and fingerprint replays same IDs; same key with changed body conflicts; concurrent decisions yield one winner |
| Stale | changed request/proposal revision, head/mapping, PA revision/projection/generation, or source pins blocks and requires reread/review |
| Outage | PA/network/database ambiguity preserves the exact durable handoff/command; retries do not create a second project or bind |
| Uncertain receipt | no raw 2xx or malformed response activates mapping; only a matching validated acknowledgement, settlement and activation may do so |
| Link existing | zero/multiple inventory matches, mismatch between binding/detail/inventory, or existing local mapping fails closed |
| Revoke/reversal | pre-send revocation blocks; post-receipt revocation marks reversal required and does not silently delete history or grant visibility |
| Separation | request mapping alone grants no portal/Delivery/Viewer/recipient access; recipient-binding approval remains independently pending |

## Decisions still needed (recommended answers)

1. **Who may approve?** Recommend a new native, scoped
   `project.request.approve` permission plus an explicit owner/manager role
   requirement initially; do not reuse broad `operations.manage` or Client
   Hub read permissions.
2. **Can a client edit a proposal after submission?** Recommend append-only
   revisions with an explicit versioned request pin before a decision is
   reserved. A changed pin invalidates an unreserved staff review. After a
   decision/command handoff exists, require a separate amendment workflow;
   never reset approval or create a second PA project for a later edit.
3. **What is a create candidate?** Recommend only a proposal with no local
   shared-project head and no PA mapping. Any discovered PA project is link/
   adoption evidence, never a create retry.
4. **What does “reversal” mean?** Recommend no automatic PA deletion or unlink.
   Keep the permanent one-to-one mapping and financial history; use an
   explicitly authorized cancellation/archive or correction with its own
   receipt. Moving a mapping would require a separately reviewed migration,
   not a normal client or staff delete action.
5. **Should approval require onboarding recipient binding?** Recommend no.
   Keep that workflow approval-pending and model any future portal access as a
   later, separately consented workflow.
6. **Can a personal or generic billing-root client propose a project without an
   organization?** Not with the present create producer. Recommend retaining
   the proposal as a proposal requiring staff triage, without silently
   converting it to `none`. Supporting these customers is still a required
   implementation gap, not a reduced launch scope. Review a generic
   client-only/billing-root contract, current mapping, PA schema and directory
   guard together. Do not use a name match or synthetic organization.
