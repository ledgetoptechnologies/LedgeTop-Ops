# Client workspace and portal roadmap

Status: approved direction; implementation in progress. Audited against Operations
main on August 25, 2026. This is a delivery plan, not a claim that the features
below are already enabled or complete.

The source handoff is the August 24 Project Alpha / Operations & Client Portal
development handoff. Its final external-collaboration workflow ends mid-list;
the preceding requirements are retained here without inventing a missing ending.

## Boundaries

- Operations is the operational layer over the existing separate Project Alpha
  installations. Do not consolidate those installations.
- Project Alpha remains generic and owns its business records, service catalog,
  pricing, contracts, invoices, and financial communications. Operations must not
  create a competing service or pricing database.
- The 3D Viewer repository is frozen for this work while Hermes owns its runtime
  changes. Record any required Viewer contract change as a separate handoff.
- Preserve existing public delivery links, authenticated delivery, thumbnail
  ownership, staff ACLs, and client authorization while extending workflows.
- Do not redesign the main dashboard before the client workflows work well.
- Code availability, automated test success, production feature flags, and a
  verified live workflow are different states and must be reported separately.
- Production migrations, mail, client invitations, access changes, and destructive
  testing are not implicit consequences of a local UI test. Use synthetic local
  data and obtain the required authority before external side effects.

## Identity and ownership model

Keep four distinct concepts:

1. **Business party:** the Operations customer, either an organization or an
   individual, which may link to multiple external business records.
2. **Source record:** a connector-qualified Project Alpha client, organization,
   project, service, or contact. Its source and lifecycle owner remain explicit.
3. **Authenticated person:** a verified issuer/subject identity, independent of
   business-contact records and reusable across independently authorized workspaces.
4. **Authorization:** explicit workspace/project/folder/resource grants and denies.

Linking business records changes presentation and operational context only. It
must not merge login identities, memberships, roles, billing authority, or content
grants. Names, email addresses, domains, and folder paths may suggest a match for
review but must never perform an automatic merge or grant access.

An operational contact need not have a login. A primary contact is not implicitly
an administrator. Service visibility determines which workflows are offered; it
does not bypass resource authorization or explicit denies.

## Audit findings that govern implementation

### Reuse existing foundations

- Dedicated Client Hub/detail routes and the oldest-first service-request queue.
- Verified portal identities, explicit scoped grants, deny precedence, invitation
  receipts, multiple manager entitlements, and staff recovery controls.
- Authenticated folder delivery and same-origin, authorization-checked file access.
- Durable notification outboxes, a five-minute file-change grace period, and the
  client notification bell.
- Signed/versioned Project Alpha service catalogs and request drafts/revisions.
- Versioned operation Job Briefs, private attachments, pinned SOP revisions,
  optimistic concurrency, and unsaved-draft protection.

### Gaps and conflicts

- Client Hub eagerly loads the directory, fails above 500 roots, and expands
  access rows inline. Detail histories fail above 200 rows. Replace those limits
  with bounded server queries and progressive navigation, not larger constants.
- Client Hub's current project list is an access-grant inventory, not complete
  business project history. Show these separately and retain `projects.view` and
  assignment/division scope checks before returning business project details.
- No meaningful client activity rollup exists. Projection refresh timestamps and
  page views must not count as business activity.
- Current Alpha projection IDs, leases, fingerprints, receipts, snapshots,
  portal roots, and catalog activation assume one producer. A second connector
  can collide with or deactivate the first producer's records. Do not enable it
  until all relevant state is source-scoped and tested.
- Current staff role synchronization also assumes one Alpha authority. A second
  connector must not gain global Operations administration from a matching role
  label or overwrite another source's user association by email.
- Completed-project hierarchy authorization currently has a global 30-day
  cutoff. The new policy instead retains ordinary client project history while
  expiring external-collaborator grants. Do not replace the global 30 with 7.
- Existing invitations intentionally cannot delegate manager authority. Peer
  client-admin appointment requires a separately bounded policy and tests.
- File notifications are currently per-object/per-recipient, lack staff Send Now
  and Cancel controls, and do not cover every authenticated v2 delivery path.
- Audit records exist in several stores but lack a unified filtered timeline;
  authenticated content access also needs deliberate audit coverage.
- Generic feedback, role-based operational contacts, project memory, selective
  recurrence, and per-client service assignments remain new work.

## Release slices

Each slice requires implementation, automated coverage, browser acceptance,
documentation, and a safe migration/rollback plan before release. Do not turn
this roadmap into one unreviewable migration or deployment.

### Navigation and delivery-link cleanup (added August 25)

- Top navigation: Dashboard, Airspace, Operations, Client Hub, Models, Data,
  then Administration. Permission-limited staff see only authorized entries.
- SOP Library lives under Operations. Existing SOP document/revision URLs remain
  usable; canonical new links use the nested Operations route.
- Models uses the existing Operations Viewer overview as its own top-level entry,
  not a Data subtab. No direct Viewer runtime work is included.
- Recent client links show at most eight links targeting the current folder or
  its descendants. A client root includes that client's subfolders; a subfolder
  excludes siblings and ancestor-wide links. Folder matching is literal and is
  applied alongside authorization before pagination.
- View folder links opens searchable, paginated scoped history. Search, Clear,
  refresh, Load More, and Back/Forward retain folder scope; View all links is
  explicit. The global history and dashboard remain unscoped but authorized.
- Search labels, inputs, buttons, helper text, recent links, and Trash have
  responsive spacing. Folder changes cancel stale reads; loading and failures
  are distinct from an empty result. Share creation refreshes the recent panel.
- Browser gates cover mobile and desktop navigation/spacing, legacy SOP URLs,
  restricted permissions, folder scoping, stale responses, errors/retry, and
  unchanged Viewer launch behavior.
- Reselecting the current Data subtab preserves its URL query/folder state.
  Confirmed link revocations survive concurrent search/filter reads; an older
  response must not make a revoked link appear active again.

Implementation notes: the optional `prefix` query on `GET /api/delivery/shares`
is an additional filter, not an authorization grant. Omitting it retains the
global authorized history. No database migration, source-object move, thumbnail
pipeline change, Project Alpha change, or Viewer change is required for this slice.

Local verification on August 25, 2026:

- Operations type checks and production build passed.
- All 697 unit tests across 98 files passed, including real local D1 coverage for
  literal folder boundaries, authorization, and filtered pagination.
- All 192 desktop/mobile browser tests passed in the final single-worker run.
  An earlier two-worker run passed 191 tests but failed one when the local browser
  could not load the stylesheet (`net::ERR_NO_BUFFER_SPACE`). The trace isolated
  that transport failure; no forced clicks or weakened assertions were used.
- Desktop/mobile screenshots were visually reviewed for navigation, search
  controls, folder scope, and the gap between recent links and Trash.
- This is a local implementation checkpoint, not a production release. No push,
  deployment, production migration, or live-data mutation was performed.

### 1. Client foundation and find/open workflow

- Introduce immutable connector provenance and an Operations business-party
  mapping without changing existing authorization identities or source URLs.
- Preserve the current connector as the compatible default. Do not activate a
  second producer before source-isolation acceptance is complete.
- Add explicit, audited, idempotent business linking with conflict detection;
  any suggested match remains operator-reviewed.
- Build a bounded operational read model for customer names, source names,
  contacts, project references, service indicators, and meaningful activity.
- Client Hub defaults to All with Organizations and Individual Clients filters.
- Server-side search reaches unloaded records by name, contact, email, phone,
  project name, and supported identifiers. Search scope must be authorized before
  pagination; no browser-only search over the first page.
- Use stable cursor pagination and responsive direct-link cards, not inline
  expansion. Preserve query/filter state in the URL and Back/Forward navigation.
- Keep pending requests visible above the directory without downloading the
  whole customer database.
- Dedicated detail pages separate scoped business projects/history from portal
  access, show honest empty states, and link to real existing workflows.
- Never show an action that silently does nothing or bypasses its ownership
  boundary. New Project/Create Document must route to an authorized Alpha action
  until an explicit versioned write contract is implemented.

### 2. Contacts and project memory

- Separate operational contacts from login principals.
- Support organization primary/billing/delivery roles plus project/site roles,
  multiple site contacts, phone/email, preferred contact method, and arrival notes.
- Reuse Job Brief revision, attachment, and SOP patterns for project memory:
  plan, actual outcome, deviations/reasons, observations, issues, successes, and
  recommendations for the next occurrence.
- Support text, private images/screenshots, PDFs, and appropriate attachments;
  annotation authoring is a deliberate feature, not assumed from file upload.
- Provide a field-friendly view with contact, arrival instructions, maps, notes,
  requirements, procedures, and deliverables.
- Create Next Occurrence / Use as Template selects copy-forward fields, creates
  a new authoritative job/project, and copies Ops-owned content independently.
- Never copy grants, invitations, completion state, invoices, or pending notices
  implicitly. Historical records and attachment provenance remain intact.

### 3. Predictable client and collaborator access

- Retain ordinary authorized client history with recent-first progressive UI.
- Apply explicit expiration to external-collaborator grants: a date, project end
  plus seven days, or manual revocation. Invitation acceptance expiry is separate.
- Define behavior for unknown end dates, extended/reopened projects, manual
  overrides, and already-expired access before enabling automation.
- Add organization invitation policy: disabled, administrator approval, or
  allowed. Preserve existing behavior until an operator explicitly configures it.
- Provide a lightweight reusable organization address book.
- Support multiple client administrators with bounded delegation ceilings,
  last-manager protection, staff override, and complete audit history.
- Notify the collaborator and inviter of scheduled expiry and revocation without
  deleting the person's account or other independent workspace memberships.

### 4. Portal-native delivery and Operations notification center

- Deliver into the selected client/project/folder using existing authenticated
  delivery infrastructure and predictable inherited permissions.
- Cover legacy and current authenticated grant producers without duplicate mail.
- Batch related changes by authorized client/project/audience into one pending
  notification with a five-minute grace window.
- Expose countdown, Send Now, Cancel, and reviewed recipient changes. Dispatch
  must recheck permissions/recipient eligibility and fence races with cancellation.
- Default recipients to explicit project/delivery contacts, not the entire
  organization. Separate notification audience from resource-access authority.
- Add a staff inbox for requests, feedback, pending notifications, integration
  failures, access changes/expiry, and other actionable events.
- Keep client preference controls as a later backlog item.

### 5. Generic feedback and service requests

- One Leave Feedback flow with typed project/folder/asset targets and a shared
  New → In Progress → Done lifecycle. Clients do not classify the feedback.
- Manual completion, optional note, idempotent notification, and an authorized
  deep link. Preserve business history without retaining duplicate media solely
  for before/after review.
- Website-element feedback and video timestamps extend the same target model
  later; they are not separate ticket systems.
- Present the Alpha service catalog category-first, with source-aware request
  routing and per-client service visibility.
- Keep internal prices private by default. Starting-at/fixed-price visibility
  requires an authoritative versioned Alpha contract; never infer it locally.
- Routine technical deployments do not automatically notify clients.

### 6. Unified activity and release acceptance

- Meaningful append-only activity records carry actor, organization/client,
  source, resource, action/result, occurred time, and replay-safe event identity.
- Client/org activity rolls up from meaningful project, task, document, delivery,
  feedback, request, and supported financial events; opening a page has no effect.
- Global audit filters and scoped client/project timelines use bounded queries.
- Authentication telemetry comes from actual authentication events, not fabricated
  page-load events. Content access auditing is bounded and avoids noisy per-chunk
  records or secrets/capability URLs in logs.
- Confirm migrations, foreign keys, source isolation, rollback/recovery, browser
  behavior, authorization, notification races, and operational runbooks.

## UI and workflow acceptance matrix

Test the complete workflow, not only whether a component renders:

- Find an unloaded customer by contact/email/phone/project; filter, Load More,
  open detail, refresh, Back/Forward, and recover from an interrupted request.
- Verify empty/loading/error/retry states, duplicate-click prevention, cancellation,
  stale-response handling, keyboard focus, labels, contrast, and long content.
- Exercise populated mobile, 13-inch laptop, standard desktop, 200% zoom, and
  ultrawide layouts. Use content-driven card sizing, not a fixed card count.
- Same source ID in two connectors stays separate; linking/unlinking customers
  never grants access; one source's snapshot/revocation cannot alter another.
- A contact with no login and a login with no grant remain distinct; access in
  workspace A must not label or authorize workspace B.
- Scoped project history is separate from access inventory; unauthorized business
  details are omitted before pagination, not merely hidden in the browser.
- Concurrent note edits conflict safely; drafts survive appropriate navigation;
  copy-forward yields independently editable records and no copied permissions.
- A collaborator sees only the granted scope; new deliveries inherit correctly;
  explicit deny wins; expiry/reopen/override and last-manager cases are tested.
- Forty related uploads produce one pending notice; accidental changes can be
  removed/cancelled; Send Now races safely; revoked access suppresses delivery.
- Feedback on an exact asset stays unambiguous, replay does not duplicate it,
  manual completion sends once, and revoked targets cannot leak their content.
- Missing or unhealthy connector/mail/scanner states are actionable and do not
  silently appear successful.

## Current checkpoint

- [x] Read and reconcile the handoff against current released Operations source.
- [x] Record the identity, authorization, source ownership, and Viewer-freeze boundaries.
- [x] Create an active goal and phased plan with UI/workflow acceptance.
- [x] Correct the existing cross-workspace eligibility display defect and regress it.
- [x] Implement and locally verify navigation and scoped delivery-link cleanup.
- [ ] Release the verified navigation slice and check it in the deployed UI.
- [ ] Implement slice 1 and verify its backend-to-browser workflow.
- [ ] Implement and verify subsequent slices without broadening authority implicitly.
- [ ] Verify live workflows after approved deployment; do not equate local tests with
      production acceptance or claim the whole roadmap is complete prematurely.
