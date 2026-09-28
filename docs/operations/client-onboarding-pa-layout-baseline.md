# Client onboarding: preserve the Project Alpha form

## Current implementation and release status (September 14)

- The local Operations recipient form follows the checked-in PA public form's
  section/field order, segmented Individual/Organization choice, conditional
  company contacts, centered desktop card, paired fields, and mobile stacking.
  Local browser/type checks establish source/layout parity only, not live PA
  staging or production parity.
- The local staff panel has an explicit existing-client prefill authorization
  action; the Client recipient page passes the private prefill result as initial
  form values. Both Workers gate this path behind separate default-off switches.
  The later checkpoints below that call the staff action or recipient handoff
  "unwired" describe earlier snapshots and are superseded by this status.
- Neither onboarding nor prefill is enabled in the staging example configs.
  Deployed two-Worker invitation, prefill, review, notification, expiry and
  revocation acceptance is still required before release. The exact PA address
  suggestion behavior is optional Google Places assistance controlled by PA
  configuration. Operations currently has only native browser autofill; this
  is not equivalent to predictive suggestions or component extraction. Preserve
  manual entry and add an explicitly configured, provider-neutral enhancement
  before claiming feature parity; do not silently reuse a map token.
- The supplied PA staging public tunnel was reachable through the signed-in
  in-app browser on September 14. Its dashboard reported `v59e8644`, and the
  staff Client Onboarding page showed no invitations. No invitation was created
  and the recipient form was not observed live. Shell probes of both the LAN
  control URL and public tunnel failed from this workspace, a reachability
  constraint of that surface rather than evidence that staging is down.

The chronological checkpoints below are retained as historical implementation
evidence; statements about what was "unwired" or "pending" apply to their
dated snapshot unless this current-status section repeats them.

## September 14 current-main parity correction

- Read the local Project Alpha tracking ref
  `origin/main:src/controllers/public_view/client_onboarding.php` at
  `51e333fb2ca2e26248b3f96588b8c126f4a2832b`. This is the local Git tracking
  ref (independently matched to GitHub main at the time of review), not proof
  of PA's live deployed form.
- That source uses a segmented Individual/Organization radio control with the
  legend "Who are you onboarding?", followed by "Your contact details",
  dynamic "Full name" / "Contact name", "Your email", "Your phone", and a
  conditional "Organization details" section containing Organization name and
  the optional general-company contact panel. Billing address and the full-width
  review action follow.
- Operations now preserves that CSS, field order, labels and responsive layout,
  while retaining the fragment-only invitation secret, required personal email,
  and its existing validation limits. These are security/contract requirements,
  not deviations that should be copied from an older PA branch.
- Client TypeScript check and build passed after this correction. Four focused
  form/recipient browser suites passed 42/42 desktop and mobile cases; their
  resulting desktop/mobile captures were visually inspected. This does not
  establish live PA staging or production parity.
- A later focused form/page rerun passed 26/26 desktop and mobile cases after
  adding computed-layout checks for the 680px desktop card, paired contact
  fields, mobile stacking and no horizontal overflow. The segmented control
  test clicks the visible label to match normal pointer use; keyboard selection
  remains separately tested. This remains local source/layout acceptance only.

## Historical September 14 stale-branch correction

- This superseded comparison used stale checkout `b847852b`, not current PA
  main. Its dropdown and simplified field-order claim is retained only to
  explain the erroneous September 14 change; do not use it as a baseline.
- The Operations recipient form now follows that primary DOM/visual order while
  retaining its existing required personal email, required organization name
  in business mode, optional general-company contacts, broader validated
  address limits, and fragment-based invitation secret transport. Copying PA's
  optional email or query-string bearer would weaken the current Ops contract.
- The current-main correction above supersedes this checkpoint. It retains the
  separate accessible name "Organization name" and the Operations-only security
  boundaries, but uses PA's segmented control and section headings.

## Latest verification checkpoint

- September 14 source recheck against Project Alpha `b1d8776c`: the PA public
  form actually labels the personal channels "Your email" and "Your phone".
  Operations now uses those exact labels. The older note below claiming PA used
  "Contact email" / "Contact phone" was incorrect. The field order, conditional
  company panel, billing address, 680px card, paired desktop fields and mobile
  stacking remain unchanged. This is local source parity, not a live deployment.
- Historical September 14 owner follow-up: preserve Project Alpha's established onboarding
  presentation and fields. Rechecked the Operations recipient component against
  the current PA public controller: the Individual/Organization selector,
  personal and conditional company contacts, billing-address order, centered
  680px card, desktop paired rows and mobile stacking are present. Aligned the
  personal email/phone labels to the then-assumed "Contact email"/"Contact phone"
  wording. Operations intentionally retains required personal email and stacks
  the outer form on narrow screens, correcting two PA-source gaps without
  changing its visual structure. After the label edit, the four focused form,
  lifecycle, submission and recipient-page browser suites passed 42/42
  desktop/mobile cases, and the Client TypeScript check passed. The PA staging
  browser was at sign-in, so this is source/local parity, not fresh live PA visual
  acceptance or a deployment claim. Do not replace this form with a new wizard.
- September 14 later local checkpoint: staff can now explicitly opt in to
  client-only or client-plus-organization prefill after creating an existing-
  client invitation. A private recipient completion combines that live 0107
  intent, the current Client Access principal, canonical PA mapping and bearer
  into durable 0103/0104/0106 evidence before the reader returns fields. Its
  wrong-bearer, wrong-principal, revoked-authority and exact-retry D1 tests pass;
  the staff panel passes 16 desktop/mobile browser cases. This remains
  **default off** in both Workers, undeployed and unverified against signed-in
  PA staging or production. Historical checkpoints below describe earlier gaps.
- September 14 current source recheck: the checked-in PA public controller and
  Operations recipient form still agree on the visible field sequence,
  Individual/Organization switch, conditional organization channels, billing
  address labels, 680px form card and narrow-screen stacking. The Client
  TypeScript check and 24 focused desktop/mobile browser cases pass. Local
  prefill transport and focused D1 gates have progressed through migration
  0106, but the governed recipient-binding writer has no staff-facing command
  or trusted proof handoff yet, so existing-client prefill is not live or
  release-ready. Earlier
  notes below are historical checkpoints, not a claim that the current form
  is missing its protected reader transport.
- September 14 privacy gate: existing-client prefill now has its own explicit
  `CLIENT_ONBOARDING_PREFILL_ENABLED=false` deployment switch on both Client
  and Operations Workers. The authenticated private handoff returns no fields
  while either side is off; focused Client and two-Worker tests pass locally.
  This does not activate prefill or replace the pending staff opt-in ceremony.
- The local binding writer now defaults to client-only disclosure. Even when a
  client has a linked organization, the organization record is included only
  with an explicit staff `includeOrganization` decision. A real-D1 test covers
  both choices and the pinned relationship revision; no organization fields
  are inferred merely from the client relationship.
- Migration 0107 adds an unmounted, immutable staff prefill-authorization intent
  for one existing client and invitation. It records no bearer, recipient
  identity or profile fields; it pins current staff/record authority and
  expires no later than the invitation or seven days. A six-hour window and
  denial on stale authority, target revision and invitation expiry pass local
  D1 tests. The staff create UI and recipient completion are still unwired, so
  this is not an active existing-client prefill feature.
- Independent review found the remaining authorization integration gap: the
  0106 binding writer does not yet require the 0107 intent. The recipient
  reader now requires an exact live 0107 intent plus its 0106 receipt as well
  as the 0103/0104/0105 identity/disclosure chain. Its seven local D1 cases
  pass, including historical-disclosure and intent-only denial; the signed
  two-Worker case denies wrong-client and revoked recipient bindings. The
  completion writer and staff command remain in local integration, and the
  separate prefill switches remain off. Before activation, completion must
  atomically connect the staff intent to the exact recipient proof, with
  expired-intent, changed-staff-authority and lost-ACK acceptance.
- September 13 direct source recheck: the PA public controller at local
  `b1d8776c` (`src/controllers/public_view/client_onboarding.php`) still has
  Individual/Organization, personal contact, conditional organization and
  general company contact, billing address, then full-width review submit in
  that order. Its public wrapper is 680px and its nested organization grids
  stack below 620px. Operations renders the same visible fields and grouping.
  This is a source comparison, not a signed-in staging or production check.
- September 13 independent read-only QA in the authoritative Operations
  worktree reran the form, lifecycle, submission and recipient-page browser
  suites: 40/40 desktop/mobile cases and Client TypeScript passed. The fields,
  labels, requiredness, keyboard behavior, 680px card, desktop two-column rows
  and narrow-screen stacking align with this checked-in PA baseline. This QA
  did not have PA controller source in its worktree, so it is a baseline
  comparison, not a fresh live PA comparison. More importantly, the recipient
  page still does not pass `initialValues`, and the public session contract
  contains only invitation ID, expiry and state. Claim local new-client
  presentation/recipient-route parity only; existing-client authorized prefill
  and its isolation tests remain release requirements.
- September 13 owner follow-up: compared the current PA public form in checkout
  `b1d8776c613fdc2c603a15d0dd26843d94340f0f` directly with the Operations
  recipient form. The visible field order, conditional organization panel,
  optional company contact, billing address, 680px card and responsive
  two-column layout still match. Client TypeScript and the focused desktop/mobile
  form plus recipient-page browser suites pass (22/22). This is local parity;
  PA staging was not reachable through the in-app browser in this check, and
  existing-client authorized prefill remains unwired.
- September 13 continuation: reran the actual recipient-page and form browser
  suites in desktop and mobile Edge after a local fixture-read sandbox
  restriction; all 22 cases passed. This verifies local rendering, submission
  routing, link scrubbing, and unavailable states. Existing-client authorized
  prefill and production deployment remain separate, unverified work.
- September 13 renewed owner request: re-read PA's public onboarding controller
  against the actual Operations form and recipient page. The 680px card,
  section/field order, labels, conditional organization contact panel, billing
  address fields, and full-width review action match; the Operations form also
  stacks every field row at narrow widths. Client TypeScript passed, and 22
  desktop/mobile browser cases for the form and actual recipient-page entrypoint
  passed. This confirms local presentation and route behavior, not deployment or
  existing-client prefill authorization. Keep the PA layout; do not redesign it.
- Renewed owner request rechecked against the actual PA public controller and
  Operations recipient component on September 13: preserve the existing 680px
  layout, section order, labels, required/optional fields and full-width action.
  No replacement wizard or additional client-facing access controls are wanted.
  This is a source comparison; it does not claim a new deployment or live test.
- Independent read-only parity review confirmed the visible layout and fields,
  but identified a remaining functional gap: `ClientOnboardingPage` does not
  currently pass authorized `initialValues`, and its recipient session returns
  only invitation identity, expiry and state. Existing-client/linked-organization
  prefilling from PA (including shared address and configured state default)
  therefore is not yet wired into the actual recipient route. The reusable
  form's prefill support alone is not end-to-end acceptance. Add a bounded,
  invitation-authorized prefill contract with expiry/revocation and cross-client
  isolation tests before claiming existing-client invitation parity.
- September 13 recipient-form verification: all 10 desktop/mobile browser cases
  passed (`f4c8cf`) after an approved local-only rerun for esbuild's Windows
  ancestor-directory restriction. Root inspected both organization-form
  screenshots: desktop paired fields and mobile stacking remain intact.
  Address overflow now names and focuses the offending field, preserves the
  entered value, and sends no request; exact-limit supplementary Unicode values
  reach the synthetic submission unchanged. Client TypeScript passed (`6b4dcf`).
- Shared/Operations Unicode address parity passed 102 pure tests (`807fdd`).
  A real-D1 enrolled-client regression (`66fad3`) confirms that the approved
  100/32/100 address is preserved in the materialized child PA command after
  parent dependency handling. This does not prove a live PA API accepted it.

- Physical MySQL address-capacity verification passed in a uniquely named local
  disposable container (`91864a`, one test/13 assertions). It applied migration
  0099 to narrow active/archive columns, preserved existing rows, verified
  information-schema widths, preserved 100-character multibyte regions and
  32-character postal codes through both storage copies, and rejected region
  overflow in strict SQL mode. This tests storage copying, not the full archive
  service or the production migration. The harness cleaned up its test container.
- Operations/shared address parity passed 101 pure tests (`ba64d3`) and
  TypeScript (`ccc09d`). The first database-backed run (`fb877e`) passed three
  files but failed seven positive onboarding approvals. Inspection found the
  approval fixture stopped at migration 0083 while the current write plan uses
  the admission-version fence introduced by 0085. The corrected full-schema
  rerun (`4c6792`, exit 0) passed all 10 approval tests, including the seven
  previously failing cases and the 100/32/100 address persisted-history case.
  This resolves the local fixture regression, not production acceptance.
- Remaining PA review/internal-client writer and review-view edits were not
  applied: the delegated PA audit's read-only authorization caused its edit
  request to be rejected. Do not work around that restriction by applying the
  same changes through another agent. Request explicit authorization for the
  four writer/view files and their focused tests; production remains untouched.

- Address parity is now being implemented locally across both repositories.
  PA migration 0099 widens active and archived client region/postal columns to
  100/32 without modifying the immutable baseline or existing values. PA's
  generic command boundary passed 32 tests/47 assertions (`7b49d9`); the new
  strict public-onboarding address parser passed nine tests/10 assertions
  (`720e79`). All 99 migration files validate. These are parser/static checks,
  not themselves evidence of MySQL or archive/restore acceptance. The later
  physical-storage MySQL result above supersedes the migration-only limitation;
  complete service-level archive/restore acceptance is still outstanding.
- Public onboarding now rejects overlength address fields rather than silently
  shortening them. Review/internal writers and their UI limits remain pending
  authorization; Operations approval parity and full API/service round-trip
  acceptance remain in progress. No PA release, production
  migration or Operations deployment has occurred.

- Re-read the PA public form and compared its fields and grouping with the native
  Operations form. The presentation baseline below remains unchanged.
- Added an HTTP regression proving decision dispatch captures deployment-only PA
  configuration before authentication awaits, never accepts a browser override,
  and does not return that configuration. The admin HTTP and Worker-routing
  suites pass 30 tests (`f4a0c6`). This is not PA synchronization acceptance.
- Browser enrollment selection is implemented locally; its review component
  passes 16 desktop/mobile cases with the actual shared styles. A fresh built
  review-route suite also passes six cases, including successful explicit PA
  enrollment with synthetic HTTP replies. Approved-record background delivery
  and live production acceptance remain pending. No
  production deployment or existing public-link change occurred.

Status: reusable Operations form, submission persistence, database-backed
authorized issuance, recipient link-opening page, staff review and review queue
are implemented locally, including explicit PA enrollment selection. Background
delivery, invitation delivery and production acceptance remain pending.
This is client onboarding, not
the separate native staff invitation/claim workflow.

The owner explicitly requested reusing PA's established layout and fields instead
of redesigning the client experience. Read-only source review used PA checkout
`a641fadc3742dff3d11eabb86c0e3797f398f989`; that initial presentation audit did
not change PA files. Later local PA validation/migration changes are recorded
separately above and have not been released.

## Source of truth for the presentation

- `src/controllers/public_view/client_onboarding.php`: public form and inline CSS.
- `public/assets/js/public-client-onboarding.js`: individual/organization toggle.
- `src/controllers/public_view/client_onboarding_submit.php`: submission fields.
- `src/views/pages/client/onboarding.php`: staff invitation and review UI.
- `tests/frontend/public-client-onboarding.test.js`: toggle regression baseline.
- `docs/workflows/client-onboarding.md`: invitation, submission and review flow.

## Preserve the field order and grouping

| Section | Fields and behavior |
| --- | --- |
| Client type | Segmented Individual / Organization radios under "Who are you onboarding?"; Individual by default for a new unbound invitation. |
| Personal contact | "Your contact details" then dynamic Full name / Contact name, required Your email, and optional Your phone. Name is full width; email/phone share a row when space permits. |
| Organization | "Organization details" and Organization name, required only in organization mode and hidden for individuals. |
| General company contact (Operations addition) | Separate shaded optional panel for general company email and phone; these never replace the person's contact details. |
| Billing address | Address, Apartment / Suite / PO box, City, State, Postal code, Country. Preserve address autocomplete and optional address fields. |
| Submit | Full-width Submit for Review action, clear validation, submitted confirmation and unavailable/expired invitation states. |

Use the centered approximately 680px form, generous spacing, section headings,
two-column field layout where appropriate, and narrow-screen stacking. Adapt
theme tokens to the unified Ledge Top portal, not drone-only branding. Preserve
keyboard/focus behavior and visible labels; no placeholder-only fields.

## Adapt the ownership, not the client-facing workflow

- Operations receives the submission and owns normal review and shared-directory
  editing. Approved records map to the explicitly enrolled PA instance(s).
- Preserve new-client and existing-client invitation use cases, including safe
  authorized prefilling; do not expose arbitrary client records through a form.
- A typed organization name or matching email is review evidence, not permission
  to auto-merge identities, join an organization or receive its documents.
- Service enrollment, billing access, staff roles and delivery grants remain
  independently authorized. Do not add confusing access controls to this form.
- Submission notification remains operational, with deduplication and no extra
  copy of PA financial emails. Submitting is not automatic portal authentication.
- Reuse the presentation and field semantics, not PHP endpoints, database IDs,
  invitation tokens or legacy PA ownership assumptions.

## Correct before copying

- The initial PA audit found a 32-character postal input being shortened to 20
  characters on submission. The local replacement now uses a 32-character postal
  limit and 100-character region/country limits with explicit validation. PA's
  remaining review/internal writers must match before release; see the approval
  boundary and migration evidence above.
- PA's small-screen CSS stacks the organization subgrids, but the outer public
  form still declares two columns inline. Verify all contact/address rows at
  narrow widths and stack them as needed while preserving the visual design.
- Switching to Individual must not submit hidden company values. PA already
  discards them server-side; preserve that protection in the new API.

## Required acceptance

- Desktop and mobile screenshots compared with the PA layout above.
- Individual/organization switching, keyboard controls, required/optional fields,
  validation and authorized prefill tested.
- A submission creates a review item, not an unreviewed identity merge or grant.
- Expired/revoked/reused invitations, retries and notification deduplication tested.
- Existing public delivery and Incoming links retain their contracts unchanged.

## Local implementation checkpoint

- `apps/client/src/client/onboarding/ClientOnboardingForm.tsx` and its scoped stylesheet
  reproduce the form above, including company/contact separation, radio keyboard
  behavior, full-width submit, 680px card and narrow-screen stacking. The form
  takes authorized initial values and an explicit submission callback; it has
  no network, token, storage or public-route logic of its own. Mount a fresh
  instance when the invitation changes; never reuse prefilling across clients.
- `packages/shared/src/client-onboarding-fields.ts` is the common UI/submission field
  parser. It validates exact fields without invoking getters, returns an
  immutable normalized snapshot, and discards company fields for individuals.
  Postal codes now use the shared 32-character limit, without silent truncation.
  Region and country fields support 100 characters. Earlier parser test totals
  below are historical; the latest parity checkpoint is recorded above.
- Seven parser tests passed (`277f82`); eight desktop/mobile browser tests passed
  (`d3464a`); TypeScript passed (`22b1b8`). Parent inspected both organization-form
  screenshots. Browser fixtures bundle the actual component in memory; their
  synthetic page/submission endpoint are not production routes. Initial fixture
  failures targeted the hidden radios instead of the visible PA-style labels;
  corrected label-click tests and independent keyboard tests pass.
- Backend integration remains required: native invitation/review persistence,
  authorized canonical create admissions, explicit organization relationships,
  idempotent submission/review and operational-notification deduplication.
  Current `operations-directory-store.ts` client state limit is two characters,
  unlike this PA form's 100; reconcile the storage/API contract before approval
  mapping, not by silently trimming user input. A business proposal must create
  or explicitly link the organization separately from its contact person.
- This is not a working production invitation link yet. An eventual controller
  must own expiry/revocation, authorized prefill, bounded transport, exact retry
  recovery and review receipts; callback resolution alone must never mean a
  client or access grant was created. Existing public links were not changed.

The [native onboarding integration contract](client-onboarding-native-contract.md)
now records submission/review ownership, exact retry behavior, canonical
organization-link prerequisites and the verified PA address-schema mismatch.
An in-flight form callback is also fenced against disable/re-enable or unmount;
the expanded 14 desktop/mobile component tests passed (`65b06b`). This UI fence
does not replace server-side expiry or revocation checks.

## Renewed owner direction — September 12

The owner reaffirmed that the existing PA onboarding form is the presentation
baseline, not inspiration for a new design. A fresh read-only comparison of PA's
public controller with the current portal component confirms the same section
order, field labels, individual/organization switch, separate optional company
contact panel, billing address fields and full-width review action. The port
retains the 680px card and adds stacking for all rows on narrow screens.
Preserve this layout while completing native submission and staff review wiring;
do not replace it with a differently structured onboarding wizard. This source
comparison is not a claim that the production link has been deployed or that
live visual acceptance is complete.

## Staff review wiring checkpoint

- The staff application now mounts the exact UUID-based review route through
  `NativeClientOnboardingReview`, using a stable native-session transport and
  an invitation-keyed component. Query strings and fragments are removed before
  mounting; the invitation ID is a selector, not an authorization credential.
- The creation receipt links to review; submitted data still requires current
  server authorization. No production deployment or public-link change occurred.
- Route and decision-builder tests passed together: 9 tests (`f4125f`). The
  joined builder, HTTP, signed staff session and real-D1 tests passed: 2 tests
  (`587ee5`), including lost-acknowledgment replay.
- Subsequent review-screen QA corrected session expiry, uncertain-decision
  recovery, search pagination and confirmation behavior. The agent reports
  10 desktop/mobile cases passing; the root's later TypeScript run also passed
  (`12dbbf`). Enrollment UI changes require another browser acceptance run.

## Staff invitation presentation follow-up — September 14

- After explicit authorized reveal, the Operations invitation panel now shows
  the full fragment-bearing link in a labelled readonly “New onboarding link”
  field with a Copy action in a responsive row, matching the corresponding PA
  presentation. The previous raw-secret-only field was removed; issuance,
  explicit reveal, expiry and authorization contracts did not change.
- Operations TypeScript `--noEmit` passed. The focused desktop/mobile browser
  spec was updated but could not run because the sandbox denied esbuild access
  to an ancestor directory. Do not claim visual/browser acceptance from the
  source and type check alone. Production invitation rollout remains gated.
