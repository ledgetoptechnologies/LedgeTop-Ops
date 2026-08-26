# Workspace address book acceptance and security checklist

Status: independent implementation and rollout checklist, August 26, 2026.
Focused synthetic local gates pass, but production activation remains blocked
on secret provisioning and an approved backup/export/erasure policy.
The ownership contract is in [address-book-workflow.md](address-book-workflow.md).

## Release-blocking ownership checks

- [ ] The only mutable contact type is visibly local and keyed by exact
  workspace, workspace source and immutable local ID.
- [ ] No API accepts an Alpha contact ID as a writable local contact ID, and no
  write targets `pa_clients`, Alpha role collections, `project.client_id`,
  legacy `projects.project_contact_*`, business-party links or portal principals.
- [ ] Duplicate names, normalized emails, phone numbers, Alpha external IDs and
  public IDs across two workspaces/sources remain independent. No heuristic
  merge, global email uniqueness or cross-tenant search result is possible.
- [ ] Business-party membership changes presentation only and cannot move,
  expose or merge local contacts.
- [ ] DTOs discriminate local contacts, Alpha business contacts, request
  snapshots, invitation recipients and portal identities. No UI label implies a
  local contact is a site role, billing recipient, member or login.

## Authorization and tenant isolation

- [ ] Every list/detail/mutation resolves the authenticated actor first and
  binds one exact active workspace and source before applying a limit.
- [ ] The initial feature rejects non-organization workspace roots. Supporting a
  standalone-client root requires an explicit product decision and matching UI
  language rather than inheriting the organization policy accidentally.
- [ ] Default list and mutation authority is a current active workspace manager.
  Identity revocation, membership revocation/expiry, workspace closure, source
  suspension and applicable denies fail closed.
- [ ] A manager in workspace A cannot read, infer counts, search, mutate, replay
  or delete a contact in workspace B, including when emails and external IDs
  collide and the same global issuer/subject belongs to both.
- [ ] If a staff override is later added, tests require an active synced
  owner/admin plus deny-aware global `team.view` and `team.manage`; division or
  project assignment alone fails. The staff actor comes from authentication,
  never the request body.
- [ ] Partial/missing schema, unsupported source mode or unavailable authority
  returns a stable unavailable response. There is no catch-all missing-table
  compatibility bypass and no implicit primary-source inference.
- [ ] Hydrated PII is followed by a fresh current-context check before response.
  A source/workspace/membership change during a slow read cannot leak the result.

## Input, output and privacy

- [ ] JSON is strict and streamed/bounded by actual bytes, with a read deadline;
  oversized, non-JSON, duplicate/unknown fields and control-bearing strings fail
  before a domain write.
- [ ] Names and channels are Unicode-normalized, trimmed and length-bounded.
  Display name and email are required; invalid email is rejected. Optional phone
  remains text and cannot prove identity.
- [ ] Responses use `Cache-Control: no-store`. PII is absent from URLs, cursors,
  logs, analytics, error text, audit detail JSON and notification payloads.
- [ ] Free-form search text is sent in a bounded authenticated request body, not
  a query string that can be retained by browser history or access logs.
- [ ] Search is server-side, bounded and authorized before pagination. Cursors
  bind workspace/source, query, sort, state revision and authorization context;
  a cursor cannot be replayed against another tenant or after deletion.
- [ ] Counts describe their record type and loaded/complete state. Local contacts
  are not silently added to projected business-contact counts.
- [ ] Source payload fields outside the documented name/email/phone allowlist are
  never returned or copied. Billing, private notes, identity and access fields
  remain excluded even when present in malformed source JSON.

## Mutation, concurrency and replay

- [ ] Create/update/delete uses a preview or equivalent canonical context,
  expected record version and actor-scoped idempotency key.
- [ ] The D1 batch begins with a guard for the exact current actor, workspace,
  source, record version and normalized operation. A zero-row guard cannot allow
  later statements to commit.
- [ ] Current record, search/index state, non-PII audit event and idempotency
  result commit atomically. Constraint failure leaves none of them committed.
- [ ] Same key and same operation after an uncertain response returns exactly one
  accepted result. Same key with different PII, workspace, action or expected
  version conflicts. Replay rechecks current authority and redacts deleted PII.
- [ ] A retry cannot substitute a later contact version or tombstone for the
  original command result. An approved signing-key rotation preserves retries
  for the documented idempotency-retention window without storing an unkeyed
  dictionary-recoverable PII fingerprint.
- [ ] Concurrent create/update/delete races have one winner and deterministic
  replay/conflict behavior. `INSERT OR REPLACE` and mutable identity columns are
  prohibited; deleted IDs cannot be restored or reused.
- [ ] Capacity is explicit. Reaching it returns an actionable bounded-capacity
  response, not an empty list, partial success or silent truncation.

## Deletion, retention and recovery

- [ ] Delete immediately removes the card from reads and picker/search results,
  clears current name/email/phone, and records a terminal tombstone with actor,
  version and time in the same transaction.
- [ ] Audit rows retain only non-PII coordinates/action/version. Search tables,
  cached DTOs, mutation results and fingerprints cannot recover raw deleted PII.
- [ ] A deleted card cannot be selected by a stale form. Submission with a card
  deleted or changed after review conflicts without falling back to typed values.
- [ ] Existing submitted request/thread snapshots and issued invitation records
  remain unchanged and are labeled historical. Contact deletion creates no
  membership revocation, invitation cancellation, mail recall or Alpha mutation.
- [ ] Backup/restore, export and support tooling has a documented PII procedure.
  Restoring an old backup cannot make a tombstoned card visible without the
  separately approved recovery process and post-restore reconciliation.
- [ ] Production retention and erasure periods have an accountable owner before
  rollout. Local tests do not claim legal-policy approval.

## Existing-workflow integration

### Service requests

- [ ] Picker use requires the same current request capability and exact target as
  manual entry. The server rechecks the card in the request submission batch.
- [ ] The request stores an explicit snapshot of reviewed contact fields. Later
  address-book edits do not rewrite a request or its immutable thread events.
- [ ] Manual free-entry remains available to previously authorized callers when
  the address-book schema/feature is absent or disabled.

### Invitations

- [ ] Selection only prefills a reviewed email. It does not prove email control,
  create an identity/member/entitlement, bypass invitation policy/approval or
  consume a different rate-limit lane.
- [ ] Any invitation status shown beside a card is labelled as history for the
  exact email in this workspace, not as the contact's identity or membership.
  Duplicate cards with that email remain separate cards.
- [ ] The existing invitation command fingerprint includes the final reviewed
  email and scope. Card changes after preview require refresh; exact invitation
  retry remains the existing invitation operation, not a contact mutation.
- [ ] No mail is produced by contact create/update/delete. Invitation mail is
  emitted only by the existing separately authorized publication path.

### Alpha and Operations reads

- [ ] Alpha contacts remain read-only and source-qualified. Moved, inactive,
  hidden-source and out-of-root contacts disappear without leaking cached fields.
- [ ] If a future picker combines local and Alpha records, equal IDs/emails in
  two sources render as distinct provenance and wrong-source selection fails.
- [ ] Client Hub staff visibility and client workspace visibility are tested
  independently; one cannot be used as proof of the other across D1 databases.

## Required migration and compatibility evidence

- [ ] Empty and populated Delivery migrations preserve all existing requests,
  invitations, identities, memberships, grants, project terms and audit data.
- [ ] Old Worker/new schema and new Worker/old schema combinations preserve the
  existing request and invitation paths. The new address-book feature is hidden
  or unavailable until the complete schema is ready.
- [ ] Current tables, indexes, triggers and guards reject source/workspace/ID
  reassignment, replacement, restoration and partial writes in real local D1.
- [ ] Creating a primary workspace whose immutable source reservation is made by
  a separate trigger, and creating an explicitly reserved secondary workspace,
  each provisions exactly one matching address-book state. Correctness does not
  depend on the execution order of sibling `AFTER INSERT` triggers.
- [ ] Pagination/query plans use indexes rooted in workspace and active state;
  worst-case authorized search/list/mutation stays inside the documented Worker
  query and response budgets.
- [ ] Rollback retains audit/tombstones and does not revive contacts or remove
  historical request/invitation snapshots.

## Minimum independent regression matrix

- [ ] Two workspaces in one source, and two sources with colliding external IDs
  and equal emails, each return only their own local and projected records.
- [ ] One global identity authorized in both workspaces receives independent
  lists; revoking one membership hides only that workspace.
- [ ] Manager versus ordinary member, expired member, explicit deny, closed
  workspace, suspended source, disabled feature and partial-schema cases.
- [ ] More records than one page, exact page-boundary delete/update, search over
  unloaded records, stale cursor and capacity exhaustion.
- [ ] Duplicate click, lost response, concurrent update/delete, authority change
  before batch and deletion during slow hydration.
- [ ] Malformed/long/control Unicode, mixed-case email, phone punctuation, empty
  optional channels and payloads containing private/billing/identity fields.
- [ ] Request picker snapshot, changed/deleted-before-submit, historical request
  after deletion, invitation prefill, policy-required approval and no-mail contact
  mutations.
- [ ] Responsive UI loading/empty/error/conflict/uncertain/deleted states,
  keyboard labels, Back/Forward and refresh without PII in the address bar.

## Explicit non-claims

Passing this checklist does not implement or authorize Alpha contact editing,
organization/project role assignment, multiple site contacts on a project,
arrival instructions, crew notes, project memory, selective recurrence, peer
administrator appointment, billing-recipient management, notification
subscriptions or production deployment. Those remain separate workflows and
authority decisions.
