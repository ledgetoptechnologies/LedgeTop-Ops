# Operations-owned client onboarding integration

This specifies the native replacement behind the PA-style client form. It is
not evidence that a public invitation or approval endpoint is deployed.

## September 24 draft-branch boundary

Draft Ops PR #118 has a private native-only approval writer with focused D1
proof, but no HTTP review-disposition route. Its base PR #116 declares the
Client-to-Ops recipient binding with disabled flags; the Operations recipient
entrypoint returns `unavailable`, and the Client Worker mounts no public
onboarding route. The staff create/reveal paths are also default-off. Older
dated implementation notes below refer to other branches and are not proof
that a usable invitation URL or client approval is deployed. Recheck the
exact branch and staging runtime before issuing any link.

## September 14 current route recheck

The existing multi-Worker tests were rerun against the current local Client
Worker, private Operations recipient entrypoint and D1 migrations. Both files
passed (3 tests): a new invitation opens and submits on either configured
portal origin with an exact retry, and authenticated existing-client prefill
requires the staff opt-in, canonical recipient proof and current authority.
Bearer-only onboarding remains usable without returning saved profile fields.
This closes a test-discovery question, not the rollout gate: both Workers still
have `CLIENT_ONBOARDING_ENABLED=false`, and prefill remains independently off.
No signed-in staging or production acceptance was performed in this recheck.

## Current delivery status — September 13

Source audit confirms that explicitly PA-enrolled approvals already compose the
durable local pipeline: approval atomically creates canonical records, audits,
relationships and destination intents; preparation verifies enrollment and actor
authority; the scheduled directory cycle materializes, dispatches and reconciles
the immutable commands. Native-only approvals deliberately create no PA intents.
Earlier statements below describing this composition as unimplemented are
historical. Production configuration, both PA receivers and deployed acceptance
are still required. Operational submission notifications are a separate missing
workflow and must not be confused with PA directory-command delivery.

The joined scheduler regression now passes against the complete migration chain
(`91cb70`, 54.14 seconds). It exercises invitation, submission, approval, parent-
before-child delivery to two independently identified PA mocks, exact-byte retry
after a lost parent acknowledgement, 100/32/100 nested address preservation,
disabled delivery and a later duplicate-free scheduler cycle. The initial flat-
address assertion was corrected; five full-D1 cycles also required increasing
the test-only allowance from 30 to 120 seconds. No runtime timeout was changed.
These are real local Operations database transitions with synthetic PA replies,
not proof of deployed PA receiver behavior or production configuration.

## Required PA layout and field parity

### Later local prefill checkpoint — September 14

The existing-client staff opt-in is mounted only behind the separate prefill
switch. The private recipient entrypoint now completes the live intent against
the verified Client principal and canonical PA mapping, writes the binding,
disclosure and receipt atomically, and then reads the current bounded fields.
The ordinary bearer-only form remains blank. Wrong bearer, changed recipient,
revoked staff authority and exact recipient retries have focused D1 coverage;
the staff panel passes 16 desktop/mobile browser cases. Both deployment switches
remain false. This is not a staging or production acceptance result, and no PA
instance or production connection was changed.

### Authenticated existing-client prefill implementation checkpoint — September 14

- The optional `/api/client-onboarding/prefill` path is separate from public
  invitation session/submit/status. The Client Worker validates the dedicated
  Client Access assertion and forwards only the invitation and a five-minute
  issuer/subject verification witness through the private Operations binding.
  Raw Access tokens, cookies and caller-selected identity headers are not
  forwarded. A bearer link alone still returns a blank form.
- The private reader requires the pending live invitation, exact active
  recipient identity binding, immutable disclosure pins/current revisions and
  relationship head, and the issuer's current profile-view allow without deny.
  It returns only the 13 PA-style form fields. Empty source fields stay empty
  for the recipient to review; final submission retains the existing parser.
- The recipient page waits for the optional prefill before mounting its form,
  avoiding a later remount that would erase entered text. Denied, absent or
  unavailable prefill falls back to the blank form; submitted/status recovery
  remains PII-free. No browser storage or query-string secret was added.
- Read-only PA source comparison confirmed the 680px centered form, labels,
  field order, two-column and mobile single-column layout. For a business,
  the organization address supplies billing fields when it has content,
  otherwise the client address does, matching PA's public form. The staging PA
  browser was at sign-in, so this is source parity, not a live visual check.
- Focused Client tests passed 21 cases, the private reader/entrypoint passed
  15 real-D1/unit cases, both TypeScript checks passed, and the recipient page
  passed 14 desktop/mobile browser cases including authorized prefill before
  editing and existing link recovery. These browser cases mock HTTP; deployed
  two-Worker and real Access acceptance remain required. The recipient-binding
  and disclosure writers also need
  operational issuance/approval wiring; the new path does **not** automatically
  prefill every historical or newly created invitation.

The September 13 discovery below is retained as the decision history; its
"not implemented" statements describe the state before this checkpoint.

### Existing-client prefill discovery — September 13

- Migration 0103 now records an explicit Access issuer/subject binding to one
  Operations client record. Its unmounted resolver requires the invitation to
  remain in the live-issuance view, so current issuer admission/profile state
  is part of this identity prerequisite. Revoked bindings remain historical;
  a new active binding can be made explicitly. The full-migration-chain D1
  issuer-fence test and Operations TypeScript check passed locally. This does
  **not** authorize disclosure of saved client data: authenticated recipient
  proof, issuer profile-view authority, relationship/version pinning, a bounded
  PII response and the real recipient-page tests below are still required.
- Migration 0104 now adds one immutable disclosure pin per invitation: the
  target client ID/current revision and, only when explicitly selected, the
  current client-to-organization relationship version, organization ID and
  current revision. Its insert guard requires current issuer admission/profile
  pins and `directory.profile.view` with deny precedence on every selected
  resource. Four full-migration-chain D1 tests passed locally after correcting
  the test actor shape and a null-default fixture error; Operations TypeScript
  passed. This is an unmounted, one-time issuer opt-in record, not a PII read or
  recipient handoff. A future reader must recheck the pins and authority at
  disclosure time; bearer-only and legacy invitations remain blank absent an
  explicit record.
- A second read-only cross-app audit traced the deployed-shape boundary:
  `apps/client/src/worker/client-onboarding.ts` reconstructs the private
  request without cookies, Access assertions, Authorization or caller-selected
  identity headers; `apps/operations/src/worker/client-onboarding-http.ts`
  returns only invitation ID, expiry and state. The actual recipient page
  passes no `initialValues`. A regression now explicitly supplies spoofed
  `X-Verified-Portal-Subject` and prefill-proof headers to the public adapter
  and confirms neither reaches the private binding (6 routing tests passed).
  This protects the existing bearer-only route but does not implement prefill.
- The source comparison identified a real missing dependency, not merely a
  missing React prop: migration 0077 pins `target_client_record_id`, but neither
  recipient identity nor an organization relationship/revision. The relationship
  head introduced in 0081 can change independently.
- Migration 0078's live issuance checks current issuer edit authority. It does
  not establish the separate profile-view authority needed to disclose saved
  details. Staff search filtering is not a substitute: direct issuance accepts
  an exact target ID without going through that search screen.
- The public session currently proves possession of the invitation secret only.
  The dedicated Client binding does not forward a verified portal identity.
  Preserve the existing recipient-verification requirement below; adding a
  database join and `initialValues` would silently weaken that requirement.
- Implementation order: establish a trusted recipient identity bound to the
  explicitly selected client; add an immutable disclosure record with the
  selected client revision and any explicitly authorized organization
  relationship/parent revision; require current issuer view rights and deny
  precedence for every disclosed record; expose only the bounded form fields
  after current invitation and recipient checks; then pass them to a freshly
  mounted form. No email/name lookup may substitute for an explicit link.
- New/unbound invitations stay blank. Submitted/status recovery remains
  PII-free. Organization general contact details must not be returned merely
  because the person is associated with that organization. Never automatically
  upgrade an existing bearer-only invitation to a saved-data disclosure grant.
- Required joined tests: wrong verified recipient with a valid bearer; swapped
  invitation/recipient binding; issuer view deny despite edit allow; revoked
  issuer/invitation; changed parent relationship; expired identity; blank new
  invitation; no submitted-data recovery; and correct client/organization
  prefilling through the real recipient page with no cross-invitation reuse.

This closes the investigation, not the implementation or production gate. The
current blank form remains intentional until the verified path exists.

The owner explicitly reaffirmed that the existing Project Alpha public client
onboarding form is the design reference, not a starting point for a redesign.
Source comparison: PA `src/controllers/public_view/client_onboarding.php`
against `apps/client/src/client/onboarding/ClientOnboardingForm.tsx` and its scoped stylesheet.

Latest local parity verification: all 38 desktop/mobile onboarding form,
lifecycle, recipient-page and submission browser tests passed. This covers
conditional organization fields, keyboard selection, responsive layout,
duplicate-submit prevention and invitation recovery. Production enablement
remains a separate release gate.

- Preserve the centered 680px card, Individual/Organization switch, section
  order, two-column desktop layout and single-column mobile layout.
- Preserve personal contact name, email and phone; organization name and the
  separate optional general company email/phone panel; billing address,
  apartment/suite/PO box, city, state, postal code and country.
- Preserve the shared contact explanations, full-width Submit for Review
  action and information-submitted confirmation. Adapt branding to Operations
  without changing the familiar form workflow.
- Field parity does not bypass API/storage constraints: the current shared
  contract permits 100-character state/country and 32-character postal values,
  without truncation. PA's remaining writer/view parity and production schema
  deployment must be verified before cutover; do not revert the form to 20.
- Do not copy bearer-only existing-client prefilling from PA: saved personal
  information still requires the recipient verification described below.

The local recipient form follows this structure and now belongs to the Client
app, with the pure field contract in `packages/shared`. Desktop and mobile
screenshots were inspected after the move. This is not a claim that the
replacement is live.

### Client-app mounting checkpoint

- The exact `/client-onboarding` frontend branch consumes and scrubs the bearer
  fragment before React renders or the existing delivery-link router runs. The
  page is lazy-loaded; no cross-app React component import is required.
- Client build (`e4698f`), moved recipient unit tests (22, `d5753e`), four browser
  suites (36, `101c12`) and expanded page/real-entrypoint tests (12, `ec571d`)
  passed. Ops typecheck passed after type regeneration (`770932`).
- Local configuration now prepares a dedicated `ClientOnboardingRecipient`
  private Ops entrypoint. Both Workers keep `CLIENT_ONBOARDING_ENABLED=false`.
  Its dispatch boundary unit tests passed (10, `3000ae`); these mock the adapter
  and do not prove deployed service binding or Cloudflare IP propagation.
- Client backend routing plus existing platform/domain compatibility regressions
  passed 67 tests (`7e9445`). These exercise the real Client router with a mocked
  private binding; they are not deployed two-Worker acceptance.
- Expanded routing tests then passed six cases (`87a375`), including both
  configured portal origins, secondary-host public-share denial, staff-reveal
  rejection and an empty HEAD body; Client typecheck passed (`8bc12f`).
- Actual local two-Worker acceptance now passes: the production Client handler
  calls the real named Ops entrypoint with real local D1, opens the same invitation
  on both portal origins, submits once, exactly retries, reads submitted status,
  and denies staff/legacy paths. Joined options-D1, HTTP and browser-transport
  tests passed 26 cases (`43383d`); Ops typecheck passed (`fd2211`). This proves
  the local binding path, not deployed Cloudflare Access policy or edge IP behavior.
- September 13 regression reran the actual Client-to-private-Ops binding with
  every current Operations migration through 0100, instead of stopping the
  fixture at onboarding migration 0080. The new invitation opened on both
  synthetic portal origins, submitted once, replayed exactly, and remained
  isolated from staff and legacy paths (1/1 joined test passed). This closes a
  local schema-drift hole in the route test; it is still not staging or live
  acceptance. Required staging secret/origin/binding evidence remains pending.
- This runtime check caught and corrected two errors hidden by Node mocks:
  Workers requires manual redirect handling (redirect responses remain rejected),
  and the Client entry module must not export its numeric bulk-cleanup test
  constant. The constant moved to a helper without changing limits. Bulk and
  routing regressions passed 45 tests after the fix (`c3f8c2`); the broader
  platform/domain/bulk set previously passed 107 (`021bec`).
- The staff options service now uses a bounded UUID predicate instead of a GLOB
  pattern rejected by D1. It uses applicable view/edit allows over the complete
  resource context and any applicable deny, and rejects results after staff JWT
  expiry. The real-D1 A+B-scope allow/deny regression is in the joined pass above.
- The staff invitation panel initially passed isolated tests: explicit choices,
  create, exact-command recovery, separate reveal
  and copy, and session/expiry clearing. Its desktop/mobile tests passed 12
  (`97d28e`). Independent review led to clearing stale options and selections
  across session changes and a synchronous guard against a second create command.
- It is now mounted at the exact `/clients/onboarding/invitations/new` branch,
  before the legacy OperationsApp session bootstrap. The full reserved admin
  API namespace is dispatched before legacy PA staff authentication, with
  default-off native administration configuration and exact-route denial.
- Native session responses now carry a validated recipient origin from the
  first configured member of the complete, validated portal origin list. The
  panel has no caller-supplied portal-origin override. A session proves native
  admission, not permission to issue; options/create/reveal recheck authority.
- The actual built Ops entrypoint plus panel passed 18 desktop/mobile tests
  (`76a2a7`), including create/reveal/copy to a secondary recipient origin and
  denial without a legacy session fallback. The joined routing/HTTP/transport
  and native-JWT/real-D1 tests passed 28 (`016ceb`); Ops build (`23dbd5`) and
  typecheck (`0d95e0`) passed. HTTP mocking in browser tests does not prove live
  Access configuration; the separate D1 test covers the real local persistence.
- Deployed private-binding acceptance, Client Hub discovery/navigation,
  canonical approval, required secrets and production access-policy acceptance
  remain release gates. No production configuration or public link was changed.

Independent UI QA added two final safeguards: existing client targets must be
canonical UUIDs in the browser transport, and the invitation's recipient origin
is pinned when its create command is first sent. Refreshing to a different
configured portal clears revealed secrets and blocks reveal/copy rather than
silently relocating the link. The original command remains available for exact
receipt recovery; discarding it after a lost acknowledgement could create a
duplicate. Every replay still requires current original-actor server authority.
Final desktop/mobile tests passed 20 (`c881f9`), including same-command recovery
after staff refresh and changed-origin denial; transport tests passed 12
(`d434a2`) and the final build passed (`8e1fc0`).

## Ownership and stages

- An authorized Operations staff member issues an invitation for a new contact
  or an explicitly selected existing canonical client. Public input cannot choose
  an existing record, staff scope, PA destination, billing recipient or grant.
- A bearer invitation permits submission of contact information, not viewing the
  client directory or authenticating to the portal. Keep the secret out of logs,
  URLs after redemption, persisted browser storage, and submission/audit bodies.
- Submission preserves a validated immutable proposal and marks the invitation
  submitted. It does not create a canonical client, organization, PA record,
  staff account or portal/file/billing grant.
- Review requires current native staff identity and authority over the proposed
  destination scopes and any existing selected records. Name/email similarities
  may be review hints only. The reviewer explicitly decides new versus existing
  contact/organization, enrollment and any separately authorized access.
- Approved canonical changes and their revision/audit/outbox intents must be
  committed consistently. Remote PA delivery is queued and acknowledged; a
  local approval is not proof that either PA instance accepted the update.

## Staff link creation workflow (implementation contract)

- The Client Hub owns this action. Staff choose a new contact or an existing
  canonical record they may edit, the intended business/division scopes where
  required, and an expiration. The server checks those scopes; a visible button
  or authenticated session alone is not permission to issue a link.
- The browser pins a command ID and the selected intent before creation. A
  timeout keeps that command and locks its intent until an explicit retry
  resolves it. Do not silently create a second invitation after an unknown
  response or reuse the command for edited fields.
- Creation returns the invitation ID, expiry, request digest and state, not a
  bearer. A separate authenticated, CSRF-protected reveal commits an audit
  record before returning the original secret to the issuing staff member.
  Both actions must recheck current native authority; PA login is not a proxy.
- Build the shareable URL with a fixed application origin and the existing
  fragment format only after successful reveal. Keep it in component memory;
  never put it in staff navigation URLs, analytics, browser storage or ordinary
  error reports. Copying is an explicit user action, not an automatic email.
- Expired, revoked or submitted links cannot reveal the secret. Existing
  receipt recovery does not reopen them. Losing an encryption key must report
  unavailability, not replace the original link or grant extra authority.
- Staff endpoints use `/api/client-onboarding/admin/session`, `/create` and
  `/reveal`, separate from the recipient submission endpoints. Route mounting,
  dedicated secret configuration, the staff UI and real acceptance remain
  required before this contract is considered delivered.

## Deployment boundary required for recipient links

Source inspection of `apps/operations/wrangler.jsonc`, `host-admission.ts`,
`src/worker/index.ts` and `apps/client/wrangler.jsonc` confirms that the Ops
Worker serves staff Ops hosts while the Client Worker serves the two portal
hosts. Do not default recipient links to the issuing staff page's origin.

- Mount the recipient page and its three exact session/submit/status routes on
  the Client Worker. Keep all staff create/reveal routes on Operations with
  native staff authentication. The existing form and transport can be reused;
  moving their entry point must not change fields or the PA-style layout.
- Connect those recipient routes to a dedicated private Operations service
  binding entry point which exposes only the recipient adapter and Ops-owned
  invitation storage. Do not reuse the Viewer issuer or delegated-share signer
  binding for unrelated onboarding actions, or share broad database authority
  with the client-facing Worker.
- The forwarding boundary must admit configured portal origins and exact
  paths/methods, preserve the original origin/CSRF-style request checks and
  bounded bodies, and use the actual edge-observed IP for quota attribution.
  It must never expose the staff create/reveal handler through this entry point.
- Supply the chosen canonical portal origin explicitly when constructing a
  recipient link. Do not broaden Cloudflare Access policy on the staff hosts
  just to make the new form reachable. Verify actual deployed portal policy
  before activation; source configuration is not evidence of live reachability.
- Test both business portal hosts, disabled/misconfigured bindings, attempts to
  forward staff paths, and unchanged delivery/Incoming/Viewer routes. Enable
  the new routes only after the complete review/approval workflow is ready.

This is the integration plan, not a claim that these bindings or routes exist.

## Submission persistence and retries

- Pin invitation ID, submission ID and normalized field snapshot before the
  first attempt. Hash the canonical snapshot and domain-separate the invitation
  secret hash by invitation ID. Persist no raw invitation secret.
- One immutable submission belongs to an invitation. Same ID and same normalized
  data may recover the original receipt; changed data or a different submission
  ID is not an overwrite. Expired or revoked invitations cannot recover through
  the public path. Staff retain separately authorized historical review access.
- Check the bearer hash, expiry and current invitation state in the database
  write statement, not only in an earlier read. Concurrent requests must not
  create two submissions or duplicate downstream notification work.
- Keep revocation and rejection separate: revocation closes the bearer workflow;
  a review decision preserves the submitted evidence and reviewer reason.
- The future controller must distinguish a definite rejection from unknown
  transport outcome, retain the pinned submission across an explicit retry,
  and not let edited fields silently reuse an earlier submission ID.

## Browser retry controller checkpoint

`src/client/client-onboarding-attempt.ts` now provides a memory-only command
controller. It normalizes and freezes fields, pins the submission ID, computes
the same domain-separated fields hash as the server and validates the exact
returned receipt. Unknown transport outcomes retain the original command for
explicit same-fields retry; they do not generate another ID or accept edits.
Invalidation aborts the local signal, drops retained credentials and rejects
late confirmation. Aborting does not prove that a server write was rolled back.

`ClientOnboardingSubmission.tsx` now attaches the controller to the PA-style
rendered form, but no production HTTP route is mounted. The adapter resolves its
`onSubmit` callback only for a validated submitted receipt, locks the original
fields during uncertainty, and offers an explicit retry above the form. It
invalidates on context changes, disablement and expiry, including expiry after
an awaited response. Public mounting must supply an authoritative deadline.
The controller intentionally has no local/session storage; page reload
loses its in-memory command. A separately authorized recovery path is required
before claiming reload recovery. Caller or transport copies of credentials are
outside its ownership; clearing references is not a JavaScript zeroization claim.

Joined controller/parser/submission tests pass: 25 tests across three files
(`8e6ffb`). This includes a real D1 commit followed by a simulated lost response,
then exact controller retry returning the original receipt with one stored row.
TypeScript check passes (`f768d8`).

## Public HTTP transport checkpoint (not mounted)

`src/client/client-onboarding-http.ts` connects the form controller to fixed
same-origin POST endpoints `/api/client-onboarding/session`, `/submit` and
`/status`. It sends the bearer in the JSON body only, omits cookies, refuses
redirects, sets no-referrer/no-store, limits responses to 4096 bytes and bounds
fetch plus response reading to 15 seconds. It never automatically retries.
Only the existing attempt controller validates a submission's exact receipt.
Session/status accept only the matching invitation ID, canonical future expiry,
and pending/submitted state, with no extra response fields.

The matching unmounted Worker adapter is `src/worker/client-onboarding-http.ts`.
It requires exact same-origin POSTs and the custom client-onboarding header,
reads bounded JSON, authenticates the bearer against current 0078 authority,
and applies keyed IP/invitation quota callbacks. Migration 0079 and
`client-onboarding-rate-limit.ts` now supply a dedicated durable quota backend;
the existing staff quota has a different contract and is not reused. Production
mounting must bind this backend rather than an always-allow callback.
Staff JWT authentication is not a client bearer requirement. A bearer must not
receive saved existing-client PII merely because the issuer could view it:
recipient identity verification is an additional prerequisite for prefilling.
Until that is implemented, pending invitations show blank fields and status
returns no contact data, target identifiers, submission fields or staff details.

Browser/controller verification: 18 synthetic tests passed (`754940`), including
unknown response followed by an identical retry, caller cancellation, stalled
fetch/body, chunked oversized response and rejection of extra session fields.
HTTP/D1 verification: 10 tests passed (`beead6`), including the actual browser
transport/controller through the HTTP adapter to D1, lost acknowledgement and
exact retry producing one row, expired/unbacked invitations, issuer revocation,
cross-origin refusal, rate denial and existing-target privacy. Tests use the
real migration chain and synthetic data, not production clients.
No public route is mounted. Protected staff issuance handoff,
recipient-verified prefill, review and notification remain launch
requirements. Losing the in-memory command or bearer on reload must never be
described as automatic recovery without a separately authorized recovery path.

## Link-opening page and durable quotas (local)

- `ClientOnboardingPage.tsx` accepts the original fragment link format
  `/client-onboarding#invitation=<uuid>&secret=<hex>`. Its bootstrap consumes and
  scrubs the fragment once before React rendering or session requests. The
  production page must retain no-referrer headers and load no analytics that
  could inspect the original location. Do not put this bearer in a query string.
- Pending sessions render the PA-style form through the existing submission
  wrapper. Reopening the original link after submission returns confirmation
  without returning personal data or sending a second submission. Reloading the
  scrubbed URL asks for the original link; automatic credential persistence is
  deliberately absent. This is explicit reopen-based recovery, not transparent
  recovery after every reload. Recipient-verified prefill remains separate.
- Eight desktop/mobile page tests passed (`8e5415`) with StrictMode, link
  scrubbing, malformed links, unavailable invitations, exact submit receipts
  and original-link recovery. Parent inspected both rendered form screenshots.
  Four additional fragment-bootstrap regressions verify query/duplicate/extra
  member rejection, history failure, immutable credentials and leaving other
  public routes untouched. Joined link/transport tests: 13 passed (`1f8813`).
- The dedicated quota table stores keyed digests only. Atomic fixed windows
  cap accepted requests, refuse clock regression or mid-window policy changes,
  and have a separate bounded cleanup for expired operational counters. This
  does not change upload retention. Six real-D1 quota tests passed (`581051`).
  The joined HTTP/quota/0001–0079 migration-chain suite then passed 20 tests
  (`23c62e`), including the HTTP adapter using the real durable quota backend.
  Final TypeScript check passed (`f23fea`).

## Encrypted link recovery checkpoint (local, not mounted)

### Staff HTTP and browser adapters

`src/worker/client-onboarding-admin-http.ts` now exposes the exact unmounted
session/create/reveal adapter. It authenticates native staff, checks origin and
CSRF, snapshots a separate client encryption keyring, enforces keyed IP/subject
quotas, and keeps ambiguous create outcomes distinct from success. The browser
adapter `src/client/client-onboarding-admin-http.ts` uses fixed same-origin
staff routes, explicit single-shot requests, bounded responses and timeouts,
and correlated reveal results. Link construction requires an explicit recipient
portal origin; it never defaults to the staff page's origin.

The joined adapter unit suites passed 15 tests (`27fdec`), and TypeScript passed
(`d641fb`). Review aligned the browser create request cap with the Worker's
16 KiB cap; a request above 8 KiB is covered. Worker unit tests mock native
authentication and handoff services, so they are not proof of real database or
signed-identity integration by themselves. A separate signed-RS256 JWT/JWKS
fixture now drives the actual browser transport, Worker adapter, native identity
resolution, durable quotas and D1 handoff services through migration 0080.
It passed (`840107`): session, a committed creation with deliberately lost
response, explicit same-command recovery, exact replay, audited reveal, and
denial after a foreign signed subject or current edit-grant revocation. It
asserts one invitation/handoff and no bearer in create replies or stored rows.
The source service/authentication paths are not mocked; only external JWKS and
edge request headers are synthetic. TypeScript also passed (`ee2c4b`).
No HTTP route, Client Hub action or deployment setting was enabled.

### Durable recovery service

Migration 0080 and `client-onboarding-handoff.ts` add server-generated invitation
credentials with AES-GCM encrypted recovery. The original issuer can explicitly
reveal a pending link only while current admission, profile, directory authority
and authentication deadline still permit it. The audit insert commits before
the secret is returned. Creation receipts never include the secret; stored
handoffs contain ciphertext rather than a plaintext bearer.

The issuer batch inserts a handoff unless every persisted pin already matches.
Mismatched collisions fail through the immutable correlation guard. Exact retries
keep the original encrypted record and the final receipt also proves its exact
presence. A deliberately injected SQLite IGNORE trigger is tested to deny a
success receipt; that test does not prove rollback after arbitrary schema
alteration. Ordinary constraint failures still use the D1 batch transaction.

The final joined handoff/issuance/submission suite passed 22 tests (`bc3b96`),
including repeated original-credential recovery, a concurrent command winner,
changed intent/actor denial, revoked authority, submitted-link reveal denial,
wrong/missing decryption keys, rotation retaining the old key, audit failure and
immutable handoff/audit records. The full 0001–0080 migration chain passed three
tests (`20e361`); TypeScript passed (`768143`). These are synthetic local checks.
Staff HTTP endpoints and the Client Hub issuance UI still need integration and
acceptance; none of this evidence establishes production availability.
  The cleanup is not scheduled and the public page/API are not mounted yet.

## Canonical approval prerequisites (remaining)

The current directory store writes one canonical record per transaction. Its
`OperationsClientProfile` has no canonical organization reference. Do not claim
that calling the store twice is atomic company-plus-contact approval.

Required integration work:

1. Model an explicit canonical client–organization relationship, preserving
   company general email/phone separately from the person's email/phone.
2. Issue exact scoped native directory create admissions with current authority
   and fixed profile/destination snapshots. Existing grants do not automatically
   become a new admission-issuing capability.
   Migration 0078 now persists the invitation's trusted business-area/division
   context for new clients. Use that context with current reviewer authority;
   never derive review access from a proposal's company name or issuer ID alone.
   Invitation issuance is not canonical create admission issuance. The staff
   review listing and approval transaction still need their own current checks.
3. Build a single reviewed-approval transaction for organization/contact/link,
   or an explicit recoverable multi-step command whose incomplete state cannot
   be shown as approved. Prefer one local D1 transaction where possible.
4. Map the canonical organization to its public ID independently in each
   enrolled PA instance before sending that instance's client organization link.
   Never substitute IDs between LTDS and LTT or enroll both implicitly.
5. Deduplicate a distinct operational submission notification; preserve PA's
   ownership of financial emails. No unsolicited portal launch invitations.

## Invitation authority implementation findings

- Operations staff authority uses `directory.profile.edit`; PA's
  `directory.client.create/update` token scopes are a separate remote application
  contract. A PA token must not become an Operations staff grant.
- Authenticate the issuer through `authenticateNativeStaff`, including current
  native admission, exact subject/profile binding and verified authorization
  deadline. Recheck these in the issuance transaction; a read-only authorization
  preflight is not a write fence.
- Persist a bounded, normalized immutable list of business-area/division scopes,
  not a single tuple. For existing clients, load the complete current scope set
  from D1 and apply current record policy, including every matching deny. Require
  independent profile-view authority before returning existing contact prefill.
- For new clients, validate all proposed active parents and require authority
  covering each proposed scope before issuing an admission. Existing migration
  0058's canonical create fence accepts one matching allow across its already
  trusted admission scope list; it is not safe to treat that as permission to
  issue a new admission containing arbitrary additional business areas. The
  admission issuer is missing, and `issued_by` alone is only a foreign key.
  Preserve existing-record edit semantics; do not silently rewrite that policy.
- Public submission must fail closed after issuer admission/subject/authority
  revocation, unless an explicit audited staff transfer/reissue workflow is
  implemented. Preserve submitted evidence independently of the former issuer.
  Migration 0078 and the submission service now enforce this rule locally.
  Rows created under 0077 without an issuance companion remain non-live; do not
  backfill authority merely because an old invitation exists.
- PA destinations require separate enrollment authority and verified mappings.
  Issuing an onboarding link does not enroll a client or authorize approval.

The advisory new-client rule is implemented in
`src/worker/client-onboarding-issuance-policy.ts`: descriptor-safe bounded input,
current native identity, active parent relationships, every-scope allow and
any-scope deny. It explicitly excludes existing targets and cannot establish
database freshness. Seven policy tests pass as part of the 23-test joined
policy/controller/parser run (`f917ea`). This helper is not a write fence;
the transaction-level implementation is recorded below.

## Database-backed issuance checkpoint

- Migration 0078 records immutable issuance commands with native subject,
  admission/profile versions and proposed scopes. New-client issuance requires
  an allow covering every proposed scope and rejects every matching deny.
  Existing-client issuance reloads the entire current D1 resource scope set;
  callers cannot substitute a narrower scope list.
- Issuance, submission and exact receipt recovery recheck current authority.
  Disabling and re-admitting an issuer cannot revive the old invitation because
  its admission version is pinned. Profile changes also require reissue.
  The issuer's verified login deadline gates issuance, not the full lifetime
  of an already-issued invitation. Invitation expiry still applies throughout.
- A database trigger also prevents direct submission inserts without live
  issuance authority. Submitted evidence remains durable after revocation.
  Issuer retry can return either pending or submitted state without recreating
  the invitation. Secrets are hashed separately and matched on exact retry;
  the request digest is not, by itself, proof of the bearer credential.
- The internal issuer accepts pinned server-generated IDs and a secret for
  retry. It is not a public request contract. Public handlers must authenticate
  staff and generate/protect the invitation handoff server-side. Authorized
  prefill additionally requires profile-view authority.
- Do not interpret every issuer error as proof of rollback. SQL constraint or
  trigger failure aborts the batch, but a missing acknowledgement or a deadline
  crossing after commit can leave a durable invitation without a usable receipt.
  Recover the same command; do not blindly issue a different invitation.
- Joined issuance/submission/policy/migration-chain tests: 28 passed, including
  the real 0001–0078 chain (`65e344`). TypeScript passed (`533689`). The rendered
  submission wrapper's StrictMode and same-ID secret-change coverage passed on
  desktop and mobile: 12 tests (`759f02`). These are local synthetic checks.
- Public HTTP transport, protected handoff/reload recovery, staff review,
  canonical organization/contact approval and notification deduplication remain
  required. No route, production database, PA instance or public link changed.

## Address compatibility gate (PA deployment prerequisite)

The initial read-only verification of PA checkout `a641fadc` found these
pre-migration inconsistencies (historical evidence, not current target limits):

- `database/baseline.sql`: `clients.state` and `archived_clients.state` are
  `VARCHAR(2)`; organization/address state fields permit 100 characters.
- The public onboarding form, submit and review accept a 100-character state.
  Actual runtime behavior for longer client values depends on MySQL SQL mode;
  do not claim either successful storage or silent truncation without testing.
- PA `GenericDirectoryCommandInput.php`, Operations directory store, directory
  routes and PA command transport enforce the client's two-character limit.
- Postal code is 20 in client storage/submit/API, but 32 in PA form/review.

The local implementation now preserves state/country up to 100 Unicode code
points and postal code up to 32, matching the shared submission parser. PA
migration 0099 widens active and archived client columns; local MySQL storage
verification passed (`91864a`). The shared/Operations Unicode parity checks
passed 102 tests (`807fdd`), and real-D1 approval-to-child-command coverage
preserves the 100/32/100 values (`66fad3`). These results supersede the old
20-character target recommendation, not the outstanding release gates.

Remaining PA review/internal writer and view edits are still permission-held,
as recorded in the [layout baseline](client-onboarding-pa-layout-baseline.md).
Full API/service round-trip and deployed receiver acceptance remain required.
An unsupported receiver must leave the write pending with an actionable
compatibility reason, never silently shorten the customer's information.

PA changes remain subject to owner review and deployment to both instances.

## Release acceptance still required

### Approval-to-directory integration gaps confirmed in source

- `operations-directory-store.ts` currently saves one organization or one client
  profile per `saveOperationsDirectoryMutation` batch. A business form contains
  both a personal contact and general company information: treating it as one
  profile would lose their distinction. Two calls to this function plus an
  approval update would not constitute one atomic approval.
- The canonical record/revision schema needs an explicit organization-contact
  relationship and durable relationship history. The immutable submitted JSON
  is evidence for review, not that relationship and not a canonical record.
- The approval transaction must bind the exact submission ID/hash and submitted
  invitation version, current independent reviewer authority, reviewed changes,
  existing record versions or new record identities, all admitted scopes, and
  deliberately chosen PA enrollments. It must commit the terminal decision,
  canonical mutations, relationship, audit and outbox intents together.
- New canonical mutations consume `native_directory_create_admissions`; the
  current store is not an issuer of those admissions. Approval must establish
  exact authorized admissions inside its protected transaction, not insert a
  broad admission ahead of time or infer enrollment from an invitation.
- `operations-directory-materializer.ts` currently emits individual stored
  profile JSON. Business contact materialization needs an acknowledged
  organization mapping first, then the corresponding PA `organizationPublicId`.
  An unlinked contact followed by a best-effort attachment is not equivalent.
- Materializer/outbox runtime dispatch and acknowledgment reconciliation still
  need to be wired. Local helper tests alone do not establish that approved
  customers will appear in either production PA instance.

Prepare transaction composition and relationship storage before enabling staff
approval. Reuse the existing mutation validation, replay and authority fences;
do not replace them with separate non-atomic calls to meet a UI milestone.

### Approval transaction implementation boundary

Source inspection of migration 0077 confirms that invitation states are only
`pending`, `submitted`, and `revoked`; submitted proposals are immutable. Do not
write an unsupported `approved` state or rebuild these historical tables merely
to display review status. Add a separate immutable decision ledger, uniquely
bound to the submission, with approved/rejected outcomes. Review status is the
proposal plus its decision; revocation remains an invitation-access operation.

The approval implementation must execute the following in one primary D1 batch:

1. Establish a decision fence for the exact submission ID, hash, invitation
   version, reviewer subject/admission/profile versions and unexpired verified
   session. Check current reviewer scope and any deny, not the invitation
   issuer's former permissions. Bind the complete reviewed command for retries.
2. For new records, issue only the exact scoped create admissions authorized by
   that fence. For existing records, pin their current canonical revisions and
   preserve enrollment unless a separately authorized enrollment change exists.
3. Apply the validated organization/contact write plans. Keep personal contact
   information separate from optional general company information. Do not
   truncate incompatible address fields or infer existing identities by email.
4. Apply the relationship plan using the resulting canonical record revisions
   (not the pre-update revisions). Its authority must cover the contact and
   both former and replacement organizations. An initial explicit unlinked
   relationship is valid for an individual; absence is not an unlink decision.
5. Insert the terminal decision and its immutable result references, including
   both canonical revisions and the relationship version. Complete the decision
   fence only after every required artifact exists. A late failure rolls back
   the decision, admissions, profiles, relationship, audits and queued intents.

Rejecting a proposal writes a reviewed decision and audit, not customer records,
PA commands or access grants. Exact retries must return the original result
only to a currently authorized reviewer; changed input with the same decision
ID is a conflict. A concurrent competing decision must not overwrite the winner.
The invitation bearer must never provide access to staff review data.

This is the required composition contract, not completed approval functionality.
Relationship persistence and version-pinned authentication are being implemented
first. Approval HTTP/UI, its decision ledger and cross-record PA dependencies
remain release gates. No invitation, approval, or organization association by
itself grants portal delivery or financial access.

The version-pinned authentication prerequisite now has local evidence:
`resolveNativeStaffIdentityWithAdmissionVersion` reads the active admission
version together with identity/profile in one primary query, and
`authenticateNativeStaffWithAdmissionVersion` preserves it with the verified
session deadline. Existing wrappers retain their original exact return shapes.
Thirteen signed-JWT tests (`762826`) and thirteen real-D1 identity/auth tests
(`e4a087`) passed; TypeScript passed (`80b4ab`). Later write fences must compare
the captured version, not fetch a new version to refresh an old authentication.

`client-onboarding-profile-projection.ts` now maps explicitly reviewed form
values to separate proposed person and organization profiles. It keeps the
shared billing address on both (as PA's existing review does), converts blank
optional values to null, never substitutes personal email/phone for missing
general company details, and does not choose record IDs or grant access. Seven
pure tests passed (`3a80b7`), covering these distinctions, Individual switching,
immutable snapshots, invalid input and preservation of international state names.
An additional test now feeds both projected profiles through the actual
canonical command snapshot helper: supported fields pass, while a long state
is explicitly rejected with the original value preserved. Together with the
new command-validator tests, 11 pure tests passed (`fa15c5`). The result still
requires transactional review; it does not bypass the outstanding address
compatibility gate.

The canonical validation/snapshot boundary is now reusable through
`operations-directory-command.ts`. The store consumes the same validated,
detached, deeply frozen command and stable profile/destination/command JSON;
it retains authority checks, replay, preflight and execution. The extraction
preserves the existing address limits and rejects getters, malformed arrays,
invalid identifiers and duplicate destinations. TypeScript passed (`f9100d`);
the composed D1 regression run is tracked separately from these pure tests.

### Composable directory writes and PA parent contract checkpoint

Migration 0081 and `operations-directory-relationship.ts` now persist a canonical
client-to-organization relationship, including explicit unlinked decisions and
append-only versioned history. Both current write authority and replay require
native enrolled records, captured staff admission/profile versions, the verified
deadline, and link/edit permission with matching denies honored for the client
and old/new parents. IDs follow the canonical UUIDv4 contract. These checks do
not grant client access or add PA enrollment.

Seven relationship real-D1 cases plus three migration-chain cases passed
(`c986e9`), including link/transfer/unlink, initial null, stale authority after
readmission, expiry during replay, unfenced writes, and composed new records plus
relationship with a late-failure rollback. The full chain through 0081 leaves
new authority and relationship tables empty. The composition test preissues
exact synthetic create admissions; it does not yet implement transactional
approval admission issuance or a terminal decision ledger. Tests predominantly
use global allows; non-global scopes and explicit former-parent denial need
additional behavioral coverage. Current Ops TypeScript passed (`1d2b1f`).

Follow-up targeted ACL verification passed six cases (`bf4251`) for resource,
assigned, business-area and division allows without global permissions, denial
on the former organization during transfer, and inactive scope-parent veto.
The full relationship suite passed 13/13 against the updated division fixture
(`7beece`); TypeScript also passed (`c3dee9`).

The store now delegates only deterministic statement construction to
`operations-directory-write-plan.ts`. Validation, detached snapshots, authority
preflight, replay/collision checks, the primary session and error handling remain
in the store. The builder neither grants permission nor executes a transaction.
Real local D1 tests passed 21 (`1c156d`), including composing organization and
client plans in one batch and rolling both back after a late runtime failure,
with neither audit/intent rows nor consumed admissions left behind. TypeScript
passed (`d03c18`). These tests use the directory migration fixture through 0066;
they do not prove the still-unimplemented onboarding decision transaction or
the final full-chain production migration rehearsal.

PA source confirms its existing generic client command already supports
`fields.organizationPublicId`: create omission/null means unlinked; update
omission preserves the link and explicit null clears it. Non-null references
are checked for current application access in PA's transaction. PA does not
accept a parent-content revision precondition; identity linkage does not require
inventing one. The returned organization identifier is `data.publicId`, not the
external canonical ID in `resource.id`.

Remaining implementation must add a separate cross-record organization
dependency, not reuse `predecessor_intent_id` (which pins an earlier revision of
the same record). Resolve the parent from an acknowledged mapping for the exact
source/application/history epoch/origin. The latest 0065 SQL guards currently
require command fields to equal the stored profile; changing only JavaScript to
append a parent ID would be rejected. Update those guards together with the
relationship/dependency schema, and verify that client acknowledgments report
the intended parent. Do not create an unlinked business contact as a fallback.

The PA acknowledgment validator now enforces that correspondence for both live
responses and stored receipts: explicit parent/null must match; create omission
must return unlinked; update omission preserves PA's existing-parent semantics.
The focused protocol suite passed 51 (`987a15`), including a 12-case parent-link
matrix with replay and mismatched valid IDs. This does not itself materialize a
parent dependency. Existing PA department memberships can also prevent parent
changes; those must remain explicit reconciliation work, not silently deleted
or reassigned during onboarding approval.

Next dependency implementation must pin one immutable parent decision per client
intent to a specific 0081 relationship history version and the exact client
revision. Explicit null is an unlinked decision; a missing decision is not.
For linked records, pin the organization revision and same-destination parent
intent/validated acknowledgment (or an explicitly verified existing mapping),
including source, application, history epoch, origin and external identity.
Never resolve an old queued intent using the latest live relationship.

The current write-plan builder consumes each canonical fence immediately.
Adding dependency completeness checks therefore requires split construction and
finalization: canonical organization/contact writes, relationship history,
per-intent dependencies, then final fence consumption in one D1 batch. Preserve
the standalone store's complete atomic path; do not leave a committed open fence
or let a worker observe a ready client intent without its decision. New client
creation, including an individual with explicit null, must use the composed
path. Existing unpinned intent history needs explicit reconciliation, not an
automatic null backfill. This design is not yet implemented.

The construction/finalization prerequisite is now available as
`buildOperationsDirectoryWritePlanStages`. Its existing combined wrapper still
returns the same complete statement sequence. All 23 real-D1 directory-store
tests passed (`c6cfb3`), including a live-fence probe between writes/finalization
and rollback after dependent work fails. No code may execute the stages in
separate committed batches. The final approval service and dependency-completion
guards must still enforce the composition contract; these primitives alone do
not establish production readiness.

Joined directory-materialization real-D1 and PA transport regressions passed
66 (`1a733b`) after the acknowledgment change. All work remains local; no PA
deployment, authority cutover, client grant or existing public link changed.

Local checkpoint: the immutable submission ledger/service and real migration
chain through 0077 pass joined parser/submission/chain acceptance (18 tests,
`36be63`). TypeScript passes (`6750eb`); 14 desktop/mobile form tests pass
(`65b06b`). These checks do not cover a production public route or approval
workflow, neither of which is mounted by this slice.

- Authorized issuance, current-scoped review, expired/revoked/reused invitation,
  corrupt input, concurrent submission, lost acknowledgement, and secret hygiene.
- Approved individual and organization workflows, existing-record selection,
  organization-before-contact PA mapping, and independent instance outages.
- No implicit identity merging, PA destination enrollment, client access or
  financial visibility. No double operational notification after exact replay.
- Desktop/mobile form, authorized prefill lifecycle, hidden company clearing,
  and no success restored after the invitation context is invalidated.
- Existing public delivery and Incoming links remain unchanged.

## Current joined acceptance and remaining staff interface — September 12

The signed-staff-JWT test now joins the actual browser transport, Worker HTTP
adapter and synthetic D1 through migration 0083. Both tests pass (`bfcae7`):
issuance/reveal and recipient submission followed by staff review/approval,
including a lost approval response and explicit byte-identical retry. The
database retains one decision, canonical contact and relationship; no PA
enrollment is inferred. View denial, foreign actor denial and revoked link
authority on replay are exercised separately. This supersedes earlier entries
that described the decision transaction as unimplemented, not their production
release gates.

The next staff interface work must provide authorized choices, not require staff
to type canonical IDs or destination tuples:

- Keep invitation issuance options separate from approval choices. Offer
  organizations only with current view/edit/link authority over the relevant
  resources and scopes, with bounded search and pagination.
- Provide the current target contact revision and organization relationship
  head through a dedicated, authenticated preparation operation. Include the
  current parent revision, rather than assuming the link-time revision is still
  current. Do not broaden ordinary directory reads with internal destination
  configuration.
- Prepare one detached decision command with stable mutation/audit identifiers
  for explicit confirmation and exact retry. Preparation is not authorization
  to commit later: the decision transaction must recheck every permission,
  current revision, invitation state and destination epoch.
- Native-only approval with an explicitly empty destination list remains valid.
  PA enrollment is a separate, deliberate authorized choice; it must not become
  a prerequisite for creating an Operations customer during an outage.
- Retain PA's client-facing form layout. Staff review may expose the additional
  scope and linkage choices, but the client form must not ask recipients to
  choose administrative grants or internal database identities.

Remaining release gates include usable staff review/approval UI, authorized
prefill, destination-linked approval acceptance, notification delivery and the
reconciled PA address contract. No live rollout or production cutover follows
from these local tests.
# Pending-review discovery and enrollment implementation contracts

- Approval-time connection validation must occur after exact committed-decision
  replay lookup and current replay authorization, but before creating new
  destination enrollment. Otherwise rotating configuration would prevent staff
  from confirming a decision that already committed after a lost response.
  Receive configuration through trusted server dependencies, never the request
  body; new nonempty destinations require exact current configured identities.
  Dispatcher validation remains independent and may pause old pending intents.
- Enrollment-choice authority must recheck both profile viewing and enrollment
  management in the same coherent database read. An earlier successful review
  does not prove viewing remains authorized after another awaited operation.
  Destination discovery must not require legacy connector tables or labels.
- Submitted-invitation discovery is a required staff workflow, not an invitation
  secret search. The proposed reader accepts the current versioned native staff
  identity and a UUID cursor, returning at most 50 minimal submitted rows plus a
  continuation cursor. Authorization must filter before pagination, using every
  current target scope or every issuance scope for a new client, with deny
  precedence. Revoked, unsubmitted and decided invitations are excluded.
- Each row contains only invitation/submission IDs, submission time, contact
  display name and client type. Opening its review rechecks current authority;
  being listed is not permission to approve, enroll or expose client documents.
- PA enrollment choices come from the existing deployment-owned API connection
  configuration and require current enrollment-management authority. Legacy
  connector registration is not a prerequisite; optional display labels are
  decorative only. This preserves the owner's secret-configured instance setup.
- A configured destination is not a claim of current PA reachability or API
  compatibility. Decision and dispatch must revalidate their respective identity,
  revision, epoch and authorization requirements. Never broaden credentials or
  infer enrollment from company name, email or service branding.
- Both readers are under implementation; HTTP/browser wiring, joined acceptance
  and production rollout remain pending. Operational submission notifications
  remain a separate required, deduplicated delivery path.

## September 14 recipient form and prefill checkpoint

- The native recipient form intentionally follows the generic Project Alpha
  public form: Individual/Organization switch, personal contact, optional
  general company channels, then billing address. It uses the same labels,
  two-column grouping and one-column mobile collapse. This is a source/layout
  comparison, not a live staging visual acceptance.
- The optional prefill route validates a signed, unexpired Client Access
  assertion, then resolves its exact standalone-client membership and source
  in Client D1 before passing a non-PII proof to the private Operations Worker
  binding. Operations checks the proof against its deployment-owned PA
  source/epoch mapping and the invitation target before reading fields. Only
  form fields can leave the reader; the invitation alone is insufficient.
  The local joined two-Worker test passed with actual Operations migrations
  through 0105; this is not a live production claim.
- A client-only disclosure is valid even if the client belongs to an
  organization: it returns the contact's fields and address, not organization
  details. The focused real-D1 reader suite passed 6/6 including this case
  and denial of a second active identity for the same client. Migration 0105
  requires each new disclosure to pin the exact recipient binding, and the
  reader rejects older disclosures without that pin.
- An unmounted governed Operations command can now create or reuse the 0103
  exact binding, append a 0104/0105 disclosure, and record an immutable 0106
  retry/audit receipt. It rechecks current issuer authority and revisions;
  a refreshed short-lived proof for the same exact principal can retry the
  same command, while a different principal cannot. Its focused D1 suite
  passes 4/4, including explicit organization opt-in and client-only default.
  No email match or organization workspace membership substitutes
  for exact-client proof. Organization-root membership still requires explicit
  client-scoped evidence or staff-mediated verification. The staff command
  interface and trusted proof-to-writer ceremony remain unwired; keep prefill
  default-off until those and live acceptance pass the owner's release gate.
- Migration 0107 and an unmounted intent writer now preserve an explicit staff
  prefill choice for one existing client/invitation, with pinned staff and
  record revisions, no PII or recipient material, and expiry bounded by seven
  days and the invitation. Its real-D1 suite passes 2/2. This is not yet
  sufficient authorization for disclosure: the recipient reader now consumes
  exact 0107 intent plus the 0106 receipt, but the 0106 staff writer still
  does not require the intent. Both Client and Operations require a separate
  `CLIENT_ONBOARDING_PREFILL_ENABLED=true` gate (false in release configs).
  The staff issuance UI, intent-to-proof completion, and exact cross-Worker
  revocation/replay acceptance remain mandatory before activation.
