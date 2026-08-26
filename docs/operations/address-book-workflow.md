# Workspace address book ownership and workflow

Status: locally implemented behind a default-off feature flag, August 26, 2026.
No production migration, activation, mail, identity or access change is
authorized by this document.

## Bounded outcome

The first useful increment is a small contact book owned by one exact Client
workspace in the Delivery database. It lets an authorized workspace manager
create, update, search and remove reusable contact cards. A later reviewed form
may copy a card's current name and email, plus its optional phone, into an existing service-request
site-contact snapshot or invitation email field.

The contact book is not a Project Alpha contact editor and is not a new customer,
project, site-role, membership or identity system. Selecting a card never sends
mail, creates access, subscribes the person to notifications, changes billing or
changes a Project Alpha record.

This bounded workflow may proceed without deciding who may author crew notes.
It does not complete the project/site-contact or project-memory outcomes in
handoff sections 3–6. Attaching a contact to an operational project role remains
blocked on the ownership choices in `project-memory-design.md`.

## Record classes that must remain separate

| Record | Authority and identity | Permitted address-book relationship |
| --- | --- | --- |
| Project Alpha client/contact | Alpha owns its name, email, phone, organization membership and source roles. Its identity is the exact source-qualified projection record. | Read-only presentation where already authorized. Never update it through the address book or match it by email/name. |
| Alpha department/project contact or billing recipient | Alpha owns the assignment, role and financial flags. These collections are not in the current Ops projection. | Unavailable is not the same as empty. Do not fabricate a local equivalent or infer one from `project.client_id`. |
| Operations business party | An explicitly reviewed presentation group of source business roots. It is not a person, workspace or grant boundary. | Must not be used as the address-book tenant or merge contacts from linked sources. |
| Local workspace contact | Delivery-owned contact card with a new immutable local ID, exact workspace/source coordinates and local lifecycle. | This is the only mutable record in the bounded increment. It remains visibly local. |
| Project/site contact assignment | A relationship between a contact and an exact source project, with role, preferences or arrival instructions. | Deferred. Creating a contact does not create this relationship. |
| Request site contact | Name/email/phone copied into one request and its immutable thread snapshot. | A picker may populate the form. Submission rechecks the selected card and stores a snapshot, not a live foreign-key presentation. |
| Portal identity or workspace member | Globally verified issuer/subject identity and current workspace authorization. | A matching email does not link the card to the identity. Removing a card does not remove an account or membership. |
| Invitation recipient | Reviewed email and scope in the existing invitation workflow. | A picker may populate the email input. Existing policy, approval, Access enrollment, publication, acceptance and expiry checks remain authoritative. |

The current source projection supports `client`, `organization` and `project`
records, but not Alpha's department-contact or project-contact role collections.
The current project detail therefore labels `project.client_id` only as a factual
linked contact and reports site and billing roles as `not_projected`. Existing
legacy `projects.project_contact_*` scalars are not a complete, versioned role
collection and must not be adopted as address-book authority.

## Safe default policy

The default is deliberately narrower than every potentially useful future use:

- The tenant is one active `portal_v2_workspaces` row and its exact
  `project_alpha_source_id`. Business-party membership, an account display name,
  an email match or a bare external ID cannot substitute for that tuple.
- The first slice is available only for an organization-root workspace. A
  standalone-client workspace does not acquire an "organization" directory by
  implication; supporting that root type is a separate product decision.
- Full contact-list read and every mutation require the current authenticated
  identity to be an active manager of that workspace. Denies, membership expiry,
  workspace/source lifecycle and identity revocation are rechecked before the
  protected read or write and again before returning hydrated PII.
- Non-manager request authors keep the existing free-entry site-contact fields.
  A broader read-only picker for them requires a deliberate product decision and
  a purpose-scoped server response; `workspace.view` alone does not silently
  become general contact-directory permission.
- No staff mutation override exists in the first slice. If one is added, the
  conservative precedent is an active synced owner/admin plus effective,
  deny-aware global `team.view` and `team.manage`, with the exact workspace and
  source still current. Directory visibility or project assignment alone is
  insufficient.
- An address-book record has no organization/project role, billing flag,
  delivery-recipient status, notification subscription, portal principal ID or
  member ID. Those values are not accepted in its write schema.
- The bounded invitation-oriented card requires a display name and usable email.
  Phone, company and descriptive trade label are optional. A future phone-only
  directory is a separate product/schema choice rather than a silent nullable
  variant of this contract.

Client-side peer-admin appointment remains a separate workflow. The first slice
may rely on managers who already hold current authority; it must not broaden who
is a manager in order to make contact management convenient.

## Proposed durable contract

The additive schema and routes implement the following release requirements:

- Each card has a cryptographically random local ID and immutable
  `(workspace_id, project_alpha_source_id, id)` identity. Email and phone are
  attributes, never unique keys. The same person may deliberately have separate
  cards in separate workspaces or sources.
- Mutable state has an integer version. Updates and removal require the expected
  version and a reviewed context that includes workspace/source, current actor
  authority and the canonical operation. A changed card, membership, workspace
  or source produces a conflict or unavailable result rather than a partial
  update.
- A successful D1 batch commits the current row, bounded search representation,
  non-PII audit event and actor-scoped idempotency result together. The first
  statement is a current-authority/write guard whose failure aborts the batch.
- Exact retry of an uncertain accepted mutation returns the one prior result.
  Reuse of the key for different canonical input conflicts. Replay still checks
  current authority and never reveals deleted or newly unauthorized PII.
- Lists use stable cursor pagination and a hard per-workspace capacity. Search
  is authorized before its limit, not performed over a browser-loaded prefix.
  Cursors bind the exact workspace/source, normalized query, sort, contact state
  revision and current authorization context.
- Responses are `no-store`. Names, emails and phone numbers are never placed in
  URLs, cursor payloads, logs, analytics labels, error messages or audit details.
  Free-form search text therefore travels in a bounded authenticated request
  body, not in a query string.
  Inputs are byte-bounded, strict JSON, Unicode-normalized and reject control
  characters. Email is validated/canonicalized for use while preserving an
  explicitly reviewed display value; phone is treated as contact text, not as
  proof of identity.

Alpha contacts may eventually appear in the same picker only as a discriminated
read-only result carrying exact source provenance and current owner proof. A
source result is not copied into a local mutable card automatically. If a user
explicitly creates a local copy, the UI must state that future Alpha changes will
not update it and that edits do not flow back to Alpha.

## Use by existing workflows

### Service request

The picker returns an opaque local contact ID and reviewed display fields. At
draft save or submit, the server verifies that the card is still active in the
same workspace/source and that the actor still has the request capability for
the selected target. It then writes the existing request-specific site-contact
fields and immutable request-thread snapshot in the same Delivery transaction.
The request retains that historical snapshot after the card changes or is
removed. A changed/deleted card between review and submit requires refresh; the
server never silently substitutes new values.

### Invitation

The picker may only prefill the recipient email. The invitation request stores
the reviewed email as it does today. Invitation policy, scope/capability checks,
access terms, rate limits, staff approval where required, Access enrollment,
mail publication, token acceptance and current identity binding remain
unchanged. A card does not prove the recipient owns that email and does not
reserve or create a portal identity.

If the UI shows invitation history beside a card, it is only the most recent
invitation sent to that exact normalized email in the same workspace. It must be
labelled as email history, not as proof that the card represents the invitation
recipient. Reusing an email address or creating two cards with the same email
does not merge their identities or access histories.

### Operations and Client Hub

Projected Alpha contacts remain in the source-qualified business-contact
collection with their current live-owner checks. A local workspace contact is a
separate record type. Client Hub must not add the two counts together unless its
DTO labels the coverage, and must not search Delivery contacts without the exact
current workspace authorization and a cross-database recheck. The initial Client
slice need not expose local contacts to staff.

## PII deletion and retention

Removal means removal from future use, not deletion of unrelated history:

- The contact mutation transaction changes the card to a terminal deleted state,
  clears its name/email/phone and any normalized search values, records actor,
  version and deletion time, and prevents restoration or ID reuse. Re-adding the
  same person creates a new ID after explicit review.
- Audit stores contact ID, workspace/source coordinates, action, version, actor
  and timestamp, but no raw or previous PII. Command fingerprints must be keyed
  or otherwise protected against dictionary recovery and are never returned.
- Request, invitation and mail records keep their own authorized historical
  snapshots under those workflows' retention rules. Removing a card does not
  rewrite a submitted request, revoke an invitation, recall sent mail or remove
  a member. The UI must distinguish those historical snapshots from a current
  address-book record.
- Rebuildable indexes and caches are scrubbed in the same accepted mutation or
  made unreadable by the terminal-state predicate. A delayed reconciliation is
  not an acceptable deletion mechanism.
- Backups and D1 recovery can temporarily contain prior PII. Operations must
  document the approved retention/export/erasure procedure before production
  use. This design intentionally does not invent a legal retention period.

## Deferred product choices

These choices are not resolved by creating a contact card:

1. Whether non-manager members may browse the full address book or receive a
   purpose-limited picker for requests.
2. Whether Operations staff may create/edit workspace contacts, and the exact
   staff permission and client-visible attribution for such an override.
3. Whether a project/site person must already exist in Alpha or may be an
   explicitly local project-only contact.
4. Which organization/project roles are operationally owned by Ops versus
   projected from Alpha. Alpha financial recipient flags remain Alpha-owned.
5. Who may assign site roles, edit arrival instructions or contribute project
   observations; how completed-project amendments work; and which contact/memory
   fields may be copied to another occurrence or customer.
6. The production PII retention/export/erasure period and support procedure.
7. Whether standalone-client workspaces need a differently named local contact
   book and, if so, who may administer it.

Items 3–5 block project/site contact and project-memory work, but not the narrow
manager-owned organization address book described above. Item 6 blocks a live
rollout, not local schema/API implementation and synthetic acceptance testing.

## Rollout boundary

The migration must be additive and create no inferred cards from Alpha contacts,
requests, invitations, members or email addresses. Deploy schema, Worker and UI
as one reviewed compatibility increment; absence or partial presence of the new
schema fails the new feature closed without breaking existing free-entry request
contacts or invitations. A rollback may retain redacted tombstones, audit and
idempotency rows. It must not delete request/invitation history or re-enable a
deleted contact from an older browser bundle.

No production source activation, data import, contact creation, mail, migration,
deployment or public mutation is part of this local checkpoint. Before enabling
`CLIENT_PORTAL_ADDRESS_BOOK_ENABLED`, provision a dedicated stable
`CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET` of at least 32 characters and
approve the backup/export/erasure policy. The secret is part of the idempotency
contract: rotate it only with a reviewed retention and retry transition.

## Local verification checkpoint

The migrated D1 address-book suite passed 8/8 cases, including the 1,000-record
capacity boundary and lost-response invitation replay after a selected contact
was deleted. Existing invitation compatibility passed 21/21, and the workspace
authorization compatibility suite passed 26/26 with a 15-second Miniflare test
budget (the unchanged 5-second budget was too small on this host).

Client type checking and the production build passed. The focused responsive
browser gate passed 30/30 cases. Management and picker layouts were visually
inspected at 375px and 1280px with no horizontal overflow. This evidence is
local and synthetic; it is not evidence of a production migration or activation.
