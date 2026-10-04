# Native staff management implementation plan

Status: partial local foundation; pure target-scope, delegation-ceiling and
control-plane candidate evaluators, migration-0067 authority storage and the
migration-0068 SQL candidate view are implemented locally. Scoped native management
reads and migration-0069 transactional profile-edit, admission-enable and
admission-disable commands and migration-0070 pending-onboarding storage are
implemented locally, together with the isolated one-time invitation-claim helper.
Migration 0071 adds disjoint staff/onboarding target storage to the generic ledger;
local migration 0072 and its cancellation helper add only the cancellation action.
Local migration 0073 and its creation helper reserve an authorized pending invitation
through the same generic command ledger; creation does not admit a staff identity.
Local migration 0074 and its approval helper atomically install the reviewed
claimed identity and grants, with local transaction tests. Other management
commands, recovery schema and invitation creation UI remain unfinished. The isolated Access-JWT
verifier and claim/status HTTP adapter are implemented locally and mounted behind
an explicit disabled configuration gate; live claimant policy is not configured.
The separate claimant page is locally implemented and browser-tested; it does not
mount the staff dashboard or activate staff admission.
Release still requires
joined acceptance and the reviewed authority upgrade; no routes are enabled here.
This plan does not activate native authentication, create a production admission,
issue a recovery approval or change the meaning of any row introduced by
migrations 0057 through 0061.

## Contract boundary

### Native staff request authentication (local prerequisite; admin routes disabled)

`authenticateNativeStaff` now verifies the configured staff Access audience and
resolves only an already-approved native admission and profile. It is separate
from the invitation-claim audience and from legacy email-binding authentication.
The feature is used only by the exact administrator onboarding routes below,
behind an explicit disabled gate. Existing staff sign-in remains unchanged;
no production route, Access policy, admission or PA account has been changed.

- Verify the configured issuer, RS256 signature, single staff audience, human
  identity claims and bounded valid lifetime before querying native identity.
- Preserve the opaque Access subject exactly and normalize only the email.
  Require both to match the active native admission/profile; never auto-bind by
  email or infer permission from PA roles or token claims.
- Snapshot configuration before asynchronous work and recheck token expiration
  after the first-primary native lookup. Lookup failures deny without fallback.
- Return an immutable native identity and verification deadline, not a legacy
  staff principal or reusable authorization grant. Each administrative command
  still checks current capability, scope and admission in its own transaction.

Root joined tests exercise real signed synthetic JWTs and local D1 with the
existing native identity resolver. Approved native access works independently
of an inactive legacy PA staff record; PA-only users, mismatched subjects/emails,
claimant/mixed audiences and revoked native admissions are denied. Database
snapshots confirm that authentication neither binds nor changes staff records.
The initial joined regression passed 12 tests (`53595c`), including the existing
nine identity tests. Final combined staff/claimant authentication, race and native
identity regression passed 31 tests across six files (`99dc27`); TypeScript passed
(`184438`). Independent review also covers configuration snapshots, lookup errors
and expiration reached during a delayed lookup. No live sign-in or production
acceptance is claimed. Administrator UI, recovery and the reviewed native
authority upgrade remain required before enabling this path.

### Administrator onboarding HTTP (local implementation; disabled)

The root router dispatches exact method/path pairs to the native
staff adapter after the existing production-host check:

| Method | Path | Browser input |
| --- | --- | --- |
| GET | `/api/native-staff/onboarding/session` | `X-Native-Staff-Request: 1`; no query parameters |
| POST | `/api/native-staff/onboarding/review` | `targetOnboardingId` |
| POST | `/api/native-staff/onboarding/approve` | `commandId`, `targetOnboardingId`, `expectedVersion: 2`, reviewed proposal/claim hashes, reason |
| POST | `/api/native-staff/onboarding/cancel` | `commandId`, `targetOnboardingId`, `expectedVersion: 1 or 2`, reason |
| POST | `/api/native-staff/onboarding/create` | `commandId`, `onboardingId`, `proposedStaffId`, login email, display name, expiry, proposal, reason; no caller-supplied secret |
| POST | `/api/native-staff/onboarding/reveal` | Creation `commandId`; explicit separate handoff request |
| POST | `/api/native-staff/onboarding/membership-options` | Exact empty object; actor comes only from native authentication |

`NATIVE_STAFF_ADMIN_ENABLED` is configured locally as `false` and
`NATIVE_STAFF_ADMIN_ORIGIN` as empty. Future explicit activation also requires
valid, distinct configured staff/claimant audiences, the native authority upgrade
and migration 0075. Creation/reveal additionally require migration 0076 and a
dedicated versioned handoff encryption keyring, not the session secret. That
keyring is loaded from the dedicated `NATIVE_STAFF_HANDOFF_KEYRING` deployment
secret; these two routes fail closed as unavailable without it. No live secret
has been installed and both existing feature flags remain disabled.
Unsupported methods
and neighboring paths are not exempted from the existing staff gate.

- These actions authenticate the existing native admission, never the legacy
  email-binding path or claimant admission. Server code inserts the actor,
  capability and contract version; browser attempts to supply those are rejected.
- Same-origin checks, a staff-bound domain-separated CSRF token, a 4 KiB streamed
  JSON limit (16 KiB for creation proposals only) and exact request fields protect
  both reads and writes. Expiration
  is checked after body consumption and before returning private review data.
- Primary-database quotas use distinct keyed admin digests in the existing 0075
  counter store: 60 requests/minute per source IP before authentication and 30
  per verified subject afterward. Counter cleanup runs if either onboarding
  feature is enabled; it does not alter file retention or onboarding history.
- Review, approve and cancel call the existing current-authority readers and
  transactional commands. Session/CSRF issuance does not grant management scope.
  Approval/cancellation retries retain the same command ID and payload; no
  identity or grant is inferred from a successful review alone.
- Responses are private/no-store with generic failures. No financial, client
  public-link, Viewer or Project Alpha routes are moved into this native gate.

Final combined verification passed **30 tests across six files** (`0f247d`):
actual signed staff JWT and local D1 lifecycle, staff/claimant route isolation,
CSRF identity binding, body-size/expiry checks and existing native-auth fences.
The joined test uses the outsider's own valid session to prove scope denial,
not merely CSRF rejection. It verifies approval replay and cancellation, denies
wrong review hashes without creating an identity, and disables a native admission
through the real command while preserving a separate complete administrator.
The same old JWT then fails. TypeScript passed (`50dfd7`) and generated binding
verification passed (`5ce6bc`). These are synthetic local tests, not production
activation or acceptance. Creation/delivery, broader grant
management and recovery remain unfinished.

### Recoverable invitation creation and handoff (locally implemented and tested)

- Creation generates one random secret server-side, stores only its digest in
  the existing invitation/receipt, and saves an AES-GCM encrypted handoff in the
  same transaction. A lost response must not create a second invitation or
  silently replace its secret. Exact retries recheck current creation authority.
- Creation receipts never contain the secret. A separate explicit reveal is
  available only to the exact original creator while currently authorized and
  while the invitation is pending and unexpired. A successful reveal is audited;
  it is not proof that the intended recipient received anything.
- Encryption uses a dedicated 256-bit key and per-ciphertext random nonce, with
  authenticated context binding the command, identity and immutable request.
  No raw secret belongs in URLs, logs, database records, or browser persistence.
- Keyring rotation selects a new active key for new invitations while retaining
  prior keys for pending handoffs until expiry or termination. Immutable encrypted
  rows are not silently rewrapped. Missing old keys deny recovery; use an
  authorized cancel/reissue instead of inventing a secret under an old command.
- Final combined tests passed **39 tests in seven files** (`e713b5`): real D1
  handoff lifecycle/atomicity plus issuance inputs, HTTP boundaries, existing
  creation and administrator route isolation. The independent handoff run passed
  **eight tests** (`3e298c`), including simultaneous identical requests, retained
  old-key rotation, wrong-key authentication failure without an audit record,
  immutable ciphertext/mappings, terminal claim/cancel/expiry and append failure
  rolling back pending reservation, fence and receipt. Corrected typed stub tests
  were rerun (**10 passed**, `978b23`). Build passed (`d925d0`, existing chunk-size
  warnings only). Final TypeScript check passed (`a53029`).
- No automated email, creation/reveal UI, live credentials or production
  activation is included in this checkpoint. The root router recognizes the
  new exact paths through its existing classifier, but cannot issue/reveal until
  the dedicated deployment secret is explicitly installed. Do not reuse production session
  keys or share handoff encryption keys between environments. Creation receipts
  have no secret; reveal uses the current verified server actor, dedicated CSRF,
  private/no-store responses and a post-read verification-deadline check.

#### Deployment configuration and acceptance gates

- `NATIVE_STAFF_HANDOFF_KEYRING` is secret JSON with exactly `activeKeyId` and
  `keys`. `keys` maps 1–8 distinct key IDs to 64-character lowercase hexadecimal
  AES-256 keys; the active key ID must be present. IDs use 1–64 ASCII letters,
  digits, underscores or hyphens. The parser limits JSON to 4 KiB UTF-8, copies
  the values before I/O and returns an immutable keyring.
- Keep this secret out of `wrangler.jsonc`, source control, screenshots, URLs and
  logs. Install independently for each environment through the normal deployment
  secret mechanism. Never use the session, public-share or PA connector secrets
  as handoff key material. No deployment secret values are generated here.
- Only create/reveal parse this configuration. Missing/invalid keys fail those
  paths with generic 503; session, review, approval and cancellation do not need
  the encryption key. Disabled native routes return 404 before parsing it.
- Rotating the active key does not re-encrypt history. Keep the previous key
  available while any pending invitation needs it, or deliberately cancel and
  reissue through authorized commands. Do not overwrite an existing key ID with
  new material or assume missing ciphertext means delivery succeeded.
- Deployment still requires migrations through 0076, reviewed native authority
  bootstrap, lockout recovery, separate staff/claimant Access audiences and full
  end-to-end acceptance. Configuration wiring alone does not activate native
  staff login or replace the legacy system.

Joined configuration/HTTP acceptance (synthetic, local): **42 tests across
eight files passed** (`3fa14d`). The signed-JWT lifecycle uses real administrator
and claimant adapters and local D1 through migration 0076, with only the synthetic
JWKS network response substituted. It covers creation, exact replay, separate
audited reveal, email-bound claim, immutable review and independent approval.
The approved person then authenticates with a staff-audience JWT, but the old
claimant-audience JWT is still denied at staff endpoints. A valid new staff
session with no management grants cannot create another invitation. The test
checks that no invitation or identity is created by denied operations.

Root Worker routing tests independently exercise `NATIVE_STAFF_HANDOFF_KEYRING`
JSON wiring and fail-closed behavior. The parser also rejects duplicate JSON
members, including escaped aliases and discarded nested values, without rejecting
valid escaped names. Build passed (`d4b507`), TypeScript passed (`9b8d9e`) and
generated binding verification passed (`8a12ba`). No production secret, native
admission, feature flag or PA configuration was changed. These results do not
replace a live Access/browser rehearsal or the remaining invitation UI and
administrator recovery work.

#### Remaining invitation UI acceptance

- Reference-options design review: add a bounded advisory create-options read,
  separate from invitation review. The latter checks approval authority and must
  not be reused as creation authorization. Each offered active membership needs
  both `staff.onboarding.create` and `staff.membership.manage`, with matching
  denies taking precedence and division parents verified. Grant choices must
  satisfy the current grant-manager authority and exact create ceiling for every
  selected membership. Empty memberships require the global authorities defined
  by migration 0073, not an inferred fallback. Do not enumerate unrelated staff
  or resources, return hidden-row counts, or insert a synthetic command to query
  ledger-backed authority. The transactional create fence remains authoritative;
  the membership reference endpoint is implemented locally as described below;
  the separate grant-scope selector remains pending.
- Compose a staff invitation using the person's name/email and explicitly
  reviewed memberships and grants. Do not copy a PA role, infer management
  authority, or silently substitute an empty proposal for requested permissions.
  Friendly scope labels must come from authorized native reference reads.
- Generate stable command/invitation/proposed-staff IDs once per confirmed
  creation. Keep uncertain requests pinned for explicit identical retries;
  never turn a timeout into a fresh invitation. A creation receipt is a pending
  invitation, not account activation, delivery confirmation or payroll setup.
- Handoff is an explicit action after creation or recovery by creation command
  ID. Keep the secret only in page memory, clear it on session/invitation expiry
  or navigation, and require another audited reveal to obtain it again. Do not
  put it into a hyperlink, URL parameter, browser persistence or telemetry.
- Show the existing claimant page URL separately from the invitation ID and
  secret, for deliberate secure delivery. Do not send unsolicited launch emails.
  Claim and independent approval remain separate; the existing administrator
  review page consumes the same invitation ID and immutable proposal evidence.

#### Authorized membership reference endpoint (local, disabled in production)

`native-staff-onboarding-membership-options.ts` reads the active native actor,
authorized business areas/divisions and the empty-membership eligibility in a
single first-primary D1 batch. SQL applies both required allows, deny precedence
and active-parent checks before each result limit. References use permanent IDs
with friendly labels; unrelated references and raw authorization rows are not
returned. No command, invitation, identity or grant is written by this reader.

Each kind is capped at 128 authorized choices plus one overflow sentinel; an
overflow fails generically instead of returning a silently incomplete list.
Unrelated hidden divisions do not consume the visible result limit. Results are
validated, duplicate-checked and frozen. `mayCreateWithoutMemberships` describes
only membership eligibility; it does not authorize arbitrary grants or activate
the proposed staff member.

The exact POST route uses the existing native admin authentication, same-origin
and CSRF checks, body/rate bounds, no-store responses and post-read session-expiry
check. It needs no handoff encryption secret and stays behind the same disabled
feature gate. The final create transaction still rechecks current authority;
options are never an authorization receipt. Grant-scope choices, creation UI
and live acceptance remain required.

Verification: the combined local selection passed **56 tests in nine files**
(`71fbe4`): membership-options, signed issuance HTTP/D1, administrator HTTP/D1,
encrypted handoff D1, handoff configuration, administrator routing, administrator
HTTP, issuance HTTP and issuance input. The signed lifecycle test now reads
options through real native JWT verification and D1 for a global creator and an
unprivileged admitted person, and rejects the claimant audience at that route.
Independent read-only review found no remaining blocker in the membership
reader. TypeScript passed (`39b919`); the local build passed (`17bf6d`) with
existing large-chunk warnings; whitespace check passed (`d91fb2`). No live
configuration, PA instance, retention setting or public-link contract changed.

### Administrator invitation review (locally implemented and tested)

#### Administrator screen acceptance criteria

The native screen at `/administration/staff-invitations` is implemented locally
against the exact default-off administrator endpoints above. It is not the
claimant page and must not initialize the legacy PA-backed staff dashboard.
The following behavior is covered by local implementation and browser checks;
production activation remains gated:

- Enter an invitation ID manually; no invitation secret or personal data in URL
  parameters, browser storage or logs. Refresh staff verification explicitly.
- Show the exact reviewed identity and every proposed membership, allow/deny
  grant and scope. IDs remain visible until a separately authorized friendly-name
  lookup exists; do not invent organization/division names or conceal broad grants.
- Pending invitations cannot be approved. Claimed invitations require explicit
  confirmation and a reason; send the reviewed version and hashes, not an editable
  replacement proposal. Put cancellation in a labeled bottom danger zone.
- Clear private review data when verification expires or the invitation changes.
  Prevent double submission in event handlers as well as disabled controls.
- Do not treat a timeout, redirect, malformed receipt or mismatched command ID as
  success. Keep an uncertain command's exact ID and payload in memory, block new
  actions, and offer only an explicit same-command retry after valid verification.
  Do not automatically retry mutations or claim that reloading proves failure.
- Use bounded responses, abort/unmount and stale-response guards, mobile/desktop
  visual checks and the existing claimant/Viewer regression tests. A successful
  UI fixture is not proof that production Access policy or recovery is ready.

Final local verification: rebuilt assets (`649d5c`), TypeScript exit 0
(`f92a25`), and **56 passing desktop/mobile browser tests** (`8f42d9`):
24 administrator-review, 30 claimant and two Viewer-shell regressions. Root
also inspected both administrator screenshots. The screen displays uncertain
command IDs and warns that reloading does not prove a failed decision. These
are mocked API browser tests, not live Access acceptance. Secure invitation
creation/delivery, authority bootstrap/recovery, normal native staff login,
and membership/delegation management remain required before activation.

The administrator review reader must return the stored canonical proposal and
version/hash pins needed by approval, not a newly inferred proposal. It accepts
an exact invitation ID and a server-verified native actor; it is not a directory
search by email or a public invitation lookup. Review requires current approval
authority over every proposed membership and the effective ceilings needed for
every proposed grant. An unrelated division manager cannot inspect the invitation.

- Read the invitation and current authorization rows in one bounded D1 snapshot.
- Reuse the target-scope and ceiling evaluators, testing parity with migration
  0074's approval rules, including per-membership coverage and cross-parent denies.
- Return only pending or claimed review data. Reject expired, cancelled or already
  approved records through this action; completed history is a separate future
  authorized read. Do not select or return the invitation-secret digest.
- Do not expose the claimant's opaque Access subject. The claimed evidence hash is
  a concurrency pin, not a bearer credential or proof of permission to approve.
- This read writes no fence, receipt, profile, admission or grant. Approval always
  repeats its own transactional authorization; a successful review is not a
  reusable authorization token. HTTP wiring and administrator UI remain gated.

`readNativeStaffOnboardingReview` now implements this boundary with seven bounded
SELECT statements in one first-primary D1 batch. It uses the existing target-scope
and ceiling evaluators per proposed membership and grant; it does not change the
approval migration or write commands. Queries do not select the invitation-secret
digest. The returned canonical proposal is deeply frozen, with pending/claimed
metadata and the exact proposal/claim hashes required for a subsequent approval.

Final verification: 30 tests across four files passed (`317a25`, 76.08 seconds),
including real D1 review-to-approval, two-area coverage, missing per-area ceilings,
current identity/deny/inactive-parent checks, null-area division grants, unrelated
exact-person parents, unchanged pending/history/identity counts and malformed-row
denial. Existing independent approval transaction tests also passed in this run.
TypeScript passed (`1335cd`). Review corrected business-area membership encoding,
derived division-parent lookups and irrelevant exact-person ceiling loading.
No route, live policy, schema migration, production data or public link changed.

### Claimed approval (0074, locally tested; not deployed)

`approveNativeStaffOnboarding` accepts the exact invitation ID, claimed version 2,
reviewed proposal hash and claim-evidence hash, along with the current verified
administrator and a reason. It cannot replace the stored proposal or set a role,
pay policy or arbitrary identity. The approver must already be admitted and must
not be the claimant; the invitation creator may approve a different claimant.

One first-primary D1 batch reserves the approval fence, creates the protected
local staff bridge with the exact claimed subject, admission and profile, and
inserts precisely the reviewed memberships and grants. It then consumes the
fence only after current authority and complete materialization checks, and
inserts the immutable receipt. The receipt's database trigger completes the
claimed-to-approved transition; a failed or zero-row transition aborts the
receipt and the entire batch. No half-approved account may remain.

The final checks verify grantors, initial versions, exact scopes and row counts,
including rejecting extra inactive grants. They install no delegation ceilings
or PA account. Existing identity collisions fail rather than update/merge those
identities. Retries verify current administrator authority and the active target's
original claimed subject; they never reinstall rows or reactivate access.

The original 0070 approval guard expected a live-staff ledger target. Migration
0074 replaces that check with the exact onboarding/proposed-staff pair and
reviewed evidence. Shared receipt correlation, authority and materialization
are separate guards to stay within D1's expression-depth limit. The generic
receipt/fence cleanup remains unchanged. Authenticated routes, isolated claim
Access policy, invitation delivery, recovery, reviewed bootstrap upgrade and
native-login activation remain separate cutover requirements.

The final independent approval and creation regression passed 23 tests across
three files (`4535ad`). This includes exact-self grants, lost acknowledgements,
late audit/terminal failures, cancelled claims, stale reviews, subject collisions,
extra inactive grants and disable-after-approval without reactivation. The
disable test seeds a separate complete control-plane administrator; the acting
reviewer's grant ceilings remain limited. Final TypeScript check passed
(`1b3550`). A final separate run passed eight more tests across the basic
approval, strict-input and existing staff-command suites (`3bfdd0`): 31 passing
tests across both final runs. All runners are terminal. These are local tests,
not live staff onboarding acceptance.

### Pending creation (0073, local only)

`createNativeStaffOnboarding` accepts an exact version-1 command and canonical
proposal. Its trusted caller generates the secret once and retains it across
exact retries. Only the secret digest reaches storage; the result contains
command/invitation identifiers and version, never the secret or proposed grants.
The current actor must be admitted with the exact verified subject. Every proposed
membership requires both creation and membership-management authority; an empty
membership list requires global creation authority. Proposed grants also require
current recipient-management authority and explicit capability/effect/creation/scope
ceilings. Each prospective membership needs a matching ceiling-backed parent for
each proposed grant; separate authorized parents can cover separate memberships.
Matching denies and inactive parents fail closed. Merely having a
permission to use a feature does not authorize granting it.

The D1 batch inserts the authorization fence, pending reservation and durable audit
receipt together. A late authority change or audit failure rolls back the entire
reservation. The receipt consumes the transient fence, as in 0071. Current-authority
views therefore read either the in-flight fence or the durable receipt: an exact
retry is read-only but cannot bypass revoked authority. Proposal validation and
secret generation remain server-side prerequisites, not authorization substitutes.

The new pending-insert guard requires a creation command; direct seeding is no
longer a normal writer after 0073. Existing invitations and cancellation history
are retained. Cancellation triggers keep their 0072 bodies with an explicit
cancellation-capability filter so they do not reject creation commands.

There is still no public invitation route, delivery email, Access claim policy
or management UI in this slice. Approval/admission is the separate local 0074
transaction above. A successful pending creation is not a usable staff account
and does not complete cutover.

Local evidence: final creation suites passed 13 tests (`72faf5`), and the root
regression passed 19 tests (`54a55b`) covering existing staff commands through
0073, cancellation, creation input and secret generation. Final TypeScript check
passed (`4a8982`). All ten recreated cancellation trigger bodies match 0072
except their added capability discriminator (`aa2584`). This is local evidence,
not deployed or end-to-end staff onboarding acceptance.

The local version-1 onboarding proposal parser now validates and canonicalizes
memberships, directory grants and management delegations before they can be
hashed or used as stored target scope. It rejects extra fields, duplicate entries,
inconsistent scope columns, accessors, sparse arrays and unsupported capabilities.
Each array is bounded to 128 entries and the whole canonical UTF-8 JSON to 8192
bytes. It copies and deeply freezes the result, with deterministic code-unit
ordering. Identity recovery, compensation, ownership and delegation ceilings are
not implicit onboarding fields. Syntax validation does not grant authority:
writers must independently verify current parents, target scope and delegation
ceilings inside their transaction. Two focused suites (eight tests, September 12,
run `0b1d76`) passed, including independent mutation/descriptor/size checks.

Routine staff management is native Operations authority. Project Alpha roles,
divisions, email matches and operational directory grants confer no staff
management authority. The existing `staff.profile.edit` and
`staff.admission.disable` delegations keep exactly their migration-0061 meaning;
they are not aliases for a broader administrator role.

The authority-storage foundation is the additive migration
`0067_native_staff_management_authority.sql`, currently local and not released.
It adds only a frozen capability catalog, new delegations and ceiling rows; it
does not seed authority or create the pending/command/recovery tables below.
Further additive migrations must use the next unused number, verified before
creation. `0062` through `0066` belong to project/directory work and must not be
renamed or overwritten.
New commands use a generic, versioned command envelope rather than a
new command table and trigger set for every action. Migration 0061, its command
receipts and its audit history remain intact and readable.

Every new command records a frozen `contract_version = 1`. Capabilities are
exact strings in a seeded, immutable catalog; catalog rows cannot be updated or
deleted. A future semantic change requires a new capability name or contract
version. There is no mutable "active policy version" switch whose change could
reinterpret an already approved command.

Contract-version-1 capabilities are:

- `staff.profile.read`, `staff.profile.edit`
- `staff.effective_access.read`, `staff.revocation_impact.read`
- `staff.onboarding.create`, `staff.onboarding.approve`,
  `staff.onboarding.cancel`
- `staff.admission.enable`, `staff.admission.disable`
- `staff.membership.manage`
- `staff.directory_grant.manage`
- `staff.admin_delegation.manage`
- `staff.identity.recover`

`staff.identity.recover` is catalogued for decisions and impact reporting, but
normal browser-held delegations cannot execute it. Recovery uses the separate
out-of-band approval boundary below.

## Minimal additive schema

`native_staff_pending_onboarding` reserves an account before it exists in any
staff identity table:

- immutable onboarding ID and proposed permanent staff ID;
- normalized login email and display name;
- invitation-secret digest, expiry, state (`pending`, `claimed`, `approved`,
  `cancelled`, `expired`) and optimistic version;
- claimed Access subject, claim time and claim-evidence hash, nullable until a
  successful claim;
- creator, approver, cancellation actor, reason and timestamps as applicable.

Partial unique indexes reserve proposed staff ID, open login email and claimed
Access subject across nonterminal records. There is deliberately no
`staff_users`, `native_staff_profiles` or `native_staff_admissions` row while an
onboarding is pending or merely claimed. PA projection code therefore has no
bridge row or profile email that it can select or mutate.

`native_staff_management_delegations` stores new catalog-backed authority. Each
row has actor, capability, allow/deny effect, target scope
(`global`, `business_area`, `division`, `exact_staff`), active flag, version,
grantor and immutable creation identity. This table supplements rather than
rewrites migration-0061 delegations. The evaluator reads both tables, treating
the two old capabilities identically in each.

`native_staff_delegation_ceilings` attaches only to an active allow delegation
for `staff.directory_grant.manage` or `staff.admin_delegation.manage`. A ceiling
specifies:

- authority domain (`directory` or `staff_admin`);
- exact capability that may be granted;
- effects the actor may create or revoke;
- maximum grant scope and its business-area/division/resource boundary;
- whether creation is permitted or the ceiling is revocation-only;
- active flag and version.

The pure policy contract represents creation/revocation explicitly as an
`operations` list (`create`, `revoke`) and grant effects as a separate
`grantEffects` list (`allow`, `deny`). A ceiling's own `effect` is allow or deny;
it is distinct from the effect of the grant being managed. These fields must
remain distinct in the later storage schema. Revocation-only is represented by
`operations: ["revoke"]`, not a general permission to delete any grant.

Migration 0067 stores these lists as independent `grant_allow`, `grant_deny`,
`operation_create` and `operation_revoke` integer flags. A loader must decode
only exact 0/1 values and retain the Cartesian-product meaning of the two lists.
The ceiling's `effect` is separate. Each ceiling parent references the new
management-delegation table, never a coincidentally equal legacy row ID.
When composing 0061 and 0067 rows, preserve their table provenance in bounded
policy-reference IDs and translate ceiling parents consistently; never merge
rows by raw IDs or treat a collision as an authority match.

Existing identities and scopes are immutable. Changes to `active` require an
exact version increment; revocation retains rows. Insertion collision guards
also block `INSERT OR REPLACE` so SQLite replacement cannot silently discard
history even when recursive delete triggers are disabled. These integrity
constraints do not replace command authorization or last-administrator checks.

A person's own permission to *use* a capability is never a ceiling and never
permits granting it. A proposed grant must fit the actor's target-management
scope and at least one matching active allow ceiling. Any applicable management
deny or ceiling deny wins. The resulting grant cannot be broader than the
ceiling, and self-targeting does not relax this subset rule.

Scope containment uses stable boundaries, not today's membership as a permanent
grant shortcut. A global ceiling contains every scope in its authority domain;
an identical scope contains itself; a business-area ceiling contains divisions
whose explicit parent is that same area. An area/division ceiling does not contain
an unqualified exact-person, directory-resource or assignment scope: those could
continue outside that area after a transfer. They need a matching exact ceiling
or a global ceiling. The recipient still independently passes target-management
authorization in all cases.

These are separate axes: a management delegation identifies staff recipients
the actor may administer, while its approved ceiling describes permissions those
recipients may receive. A target division is not necessarily the same domain as
a directory-resource scope. Do not replace the two independent checks with a
same-scope-string comparison. Installing or changing the ceiling itself still
requires the future transactional, independently authorized command path.

Deactivating a parent does not delete historical ceiling rows. An active child
flag is insufficient authority: every read and command must also require the
current effective parent. After parent revocation, deactivating a retained child
must remain possible; reactivating that child requires an active valid parent.

Directory ceilings cover the existing global/business-area/division/assigned/
resource scopes. Staff-administration ceilings cover global/business-area/
division/exact-staff scopes. Normal delegation never authorizes identity
recovery. A matching deny ceiling blocks overlapping grants, including a broad
proposed grant that would encompass a narrower deny. For cross-kind scopes where
stable IDs alone cannot prove disjointness, treat the overlap as unresolved and
deny rather than inferring future membership. Distinct same-kind scope IDs, and
divisions with demonstrably different area parents, can be proven disjoint.

Revocation uses the same domain/capability/effect/scope checks against the actual
stored grant loaded by the server. Removing a deny can broaden access; an API
caller must not describe a narrower or different grant to pass these checks.
Ceilings are usable only through their current matching active allow delegation.
No ceiling self-authorizes its parent, and a caller-supplied success boolean is
never an input to this decision.

`native_staff_management_commands` is the immutable audit/receipt ledger. It
stores command ID, contract version, capability, canonical request and result
hashes, actor and verified subject, target/onboarding ID, expected versions,
reason and execution time. A short-lived `native_staff_management_fences` table
supports the migration-0061 mutation-count pattern: a state mutation consumes
the expected write count, audit insertion requires zero remaining writes, and
the audit trigger removes the fence. This makes no-op, partial and audit-only
success impossible inside a D1 batch.

Add `version` columns and immutable-identity/version-step triggers only to
existing mutable authority rows that lack them, notably
`native_directory_grants`. Do not rewrite old grant identity or audit rows.

`native_staff_recovery_approvals` and immutable recovery receipts mirror the
bootstrap approval boundary. An approval binds target permanent ID, exact old
admission/profile versions, exact new Access subject and login email, evidence
hash, executor, expiry and revocation state. No HTTP staff-management route can
issue one.

### Transactional profile and admission lifecycle commands

Migration `0069_native_staff_management_commands.sql` introduces the versioned
command ledger and short-lived write fences. `executeNativeStaffManagementCommand`
currently implements `staff.profile.edit`, `staff.admission.enable` and
`staff.admission.disable`; other catalog capabilities are rejected, not treated
as implicit authority. The exact request identifies
the command, contract version, verified actor/subject, target staff ID, expected
admission version (or profile version for a profile edit) and reason. A profile
edit additionally requires only `displayName`, which is recorded in the durable
result. It cannot change login email, subject, admission, memberships or grants.
Enable requires an existing inactive bound admission and an explicit new enable
capability; it creates no account and preserves existing bindings and grants.
Legacy profile-edit authority does not imply enable authority. The frozen receipt
contains no raw Access subject.

The command uses both legacy and new same-action delegations without combining
their row identities. Scope and deny checks run in SQL inside the mutation batch,
alongside native actor/profile, target profile, active membership parents and
optimistic target-version checks. The inserted fence proves the actor and target
had the appropriate prestate before the mutation; only the matching action and
version transition consumes its write counter. Receipt insertion rechecks
authority and the action-specific resulting state. A separate trigger requires
a surviving complete 0068 candidate for an admission disable in that
same transaction. Separating assertions avoids D1 expression-depth limits without
moving the check outside the transaction.

Self-disable is permitted only with a surviving candidate and the matching
pre-mutation identity proof; that disabled actor cannot replay. An exact replay
otherwise requires current authority and the original canonical request hash.
Receipt update, delete and replacement are rejected. A fabricated consumed fence
or an audit-only insert cannot stand in for the required state transition.

The pending fence has a unique action/target/expected-version/result-version
identity. Different command IDs cannot reserve the same mutation and then claim
two receipts from one write. The consume triggers also preserve login identity:
profile-edit cannot consume a write that changes login email, and admission
enable/disable cannot consume a write that changes subject or admitting actor.
Dedicated profile/enable scope and legacy/new deny tests now accompany the
earlier lifecycle tests. Authenticated route acceptance remains outstanding.

A database acknowledgement failure is an uncertain result, not proof of rollback
or revoked permission. The command rejects malformed acknowledgements; a caller
must retain the command ID and resolve an exact retry under current authorization.
Future HTTP/UI adapters must not interpret every sanitized command error as a
definitive access denial or invent successful completion.

Migration 0061 and its service remain unchanged for compatibility testing. Their
two-action guard is not the expanded control-plane guard. Before native routes
are activated, all ordinary admission revocations must use the replacement path;
the old service must not remain an alternate runtime bypass. Delegation, ceiling,
membership, onboarding and recovery mutations still need their own checked
command implementations. This slice neither installs bootstrap grants nor
changes deployed authentication.

## Pending invite and Access claim flow

### Claimant page (local browser verification; not deployed)

- Exact `/staff-onboarding` renders `NativeStaffOnboarding` before the normal
  Operations app. It never requests `/api/session`; other entry routes retain
  their existing behavior. No production Access policy was changed.
- The invitee manually enters the invitation ID and secret. Application code
  keeps them in component memory, not URLs, Web Storage, cookies or logs. The
  password input discourages autofill; clients must still protect their device.
- A dedicated GET session supplies claimant CSRF and a verified deadline. Claim
  and status send only their exact POST contracts with same-origin credentials,
  no-store, no-referrer and redirect rejection. Responses are bounded to 4 KiB
  and validated against the submitted ID and allowed state/version pairs.
- Requests have a ten-second timeout and unmount cancellation. An ambiguous
  claim is never retried automatically: explicit status recovery must resolve it.
  Failed status does not re-enable another claim. In-flight fields are locked;
  form submission independently checks the same guards as the buttons.
- Expiry is rechecked before POST. Session refresh is explicit and does not
  retry a mutation. Approval text describes historical invitation approval, not
  current staff admission or a successful Operations sign-in.
- Local final build passed (`a2e256`), TypeScript passed (`1d359b`), and 32
  Playwright cases passed across desktop/mobile Edge (`e071b8`): 30 claimant and
  regular-entry checks plus two existing Viewer-shell regression cases. Desktop
  and mobile screenshots were inspected for layout and overflow. These use
  synthetic API fixtures; they do not prove live Access policy, invitation
  delivery, administrator approval UI or a native staff login works end to end.
- The application bundle still produces the existing large-chunk warning. The
  page uses the shared bundle; code splitting is a separate performance task,
  not a failed build or permission bypass.

### HTTP integration boundary (local implementation; disabled)

The isolated `authenticateNativeStaffOnboarding` verifier has no database binding,
staff principal or Access-policy mutation. Its explicit trusted
configuration must enable a distinct onboarding audience and specify the issuer
and existing staff audience. It checks a signed RS256 assertion, the exact dedicated
audience, human identity claims and the token-derived deadline; it preserves the
opaque subject and returns only frozen claimant identity evidence. A valid result
still requires invitation possession and pending-state checks in the claim helper.
It is not authorization to use Operations.

The implementation follows Cloudflare's [JWT validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
and [application-token claim definitions](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
Synthetic signed-token tests do not establish that a live claimant policy exists
or that an end-to-end onboarding request is enabled.

Final local verification passed eight tests across the signed-token and independent
timing/configuration suites (`6fcdd1`); TypeScript passed (`b89960`). Review fixed
configuration rereads by taking one primitive snapshot, rejected control characters
before email normalization and bounded expiry to the claim helper's four-digit ISO
year format. The independent tests verify expiration during key retrieval and
configuration mutation during verification. No production routes, bindings,
staff rows, Access policies, public links or retention settings changed.

- Pending invitees must not use `authenticateStaff`: that legacy path can bind
  an email-matched `staff_users` row and requires an already provisioned staff
  account. A claimant identity is not a `StaffPrincipal` and grants no staff access.
- Keep the host admission, security headers and no-store behavior. Insert only
  exact claim/status method-and-path dispatch before the general `/api/*` staff
  middleware; never extend the machine-event bypass or exempt a broad URL prefix.
  Neighboring routes and unsupported methods must retain ordinary denial.
- Verify the Access signature against a trusted configured issuer and a dedicated
  claimant audience, distinct from the staff audience. Preserve the exact opaque
  subject and derive the sign-in deadline from the verified token. Browser body
  identity fields, identity headers and cached email are not authentication.
- Claim and secret-bearing status requests need bounded, exact JSON bodies,
  same-origin checking and a claimant-specific CSRF protocol. Do not fabricate
  a staff principal to reuse staff CSRF. Secrets belong in POST bodies, never
  query strings, logs, receipts or responses. Status is historical workflow state,
  not proof of active staff admission.
- Test the exact dispatch and its neighboring routes, wrong audience/issuer,
  expired identity, oversized input, foreign origin, CSRF failures and a complete
  claim/status/independent-approval flow before enabling the isolated Access policy.
  No pending email is added to the main staff Access group. Production configuration
  and route activation remain cutover work, not implied by a unit-tested verifier.

`index.ts` now dispatches only GET `/api/staff-onboarding/session`, POST
`/api/staff-onboarding/claim` and POST `/api/staff-onboarding/status` to this
adapter before normal staff authentication. All neighboring method/path pairs
retain the existing staff middleware. The session request requires the custom
`X-Onboarding-Request: 1` header; mutations require an exact Origin and claimant
CSRF token. Claim/status bodies are limited to 2,048 bytes even without a declared
length. No identity fields from a browser are forwarded.

Local Wrangler configuration sets `NATIVE_STAFF_ONBOARDING_ENABLED` to `false`,
with empty `NATIVE_STAFF_ONBOARDING_AUD` and `NATIVE_STAFF_ONBOARDING_ORIGIN`.
The adapter uses the configured team issuer and staff audience, plus a distinct
claimant audience and one explicitly selected HTTPS origin. The existing session
secret is used only with domain-separated claimant CSRF and rate-key messages;
no secret is added to configuration. Generated Worker types reflect these vars.

Migration 0075 adds only a dedicated request-counter table in Operations D1.
An atomic primary-database UPSERT enforces one-minute quotas (60/IP, 30/subject)
and stores keyed digests rather than addresses or identities. A later window
reuses the row; changing a limit cannot reset the current window. Failures deny
the request. The gated ordinary scheduler prunes at most 500 counter rows older
than 24 hours per invocation using an indexed window lookup; current quotas and
invitation evidence remain intact. These counters are not staff or invitation authority and do not touch
Incoming storage, public delivery, retention or PA records.

Before activation, configure the minimal claimant Access application for these
exact paths, finish invitation delivery and UI, rehearse recovery and complete the
reviewed native-admission upgrade. Turning this flag off stops claim/status but
does not revoke or delete already approved staff. No live policy or flag was
changed during local implementation.

Final local evidence: 25 tests passed across six auth, HTTP, routing, quota and
joined-lifecycle suites (`b09996`); TypeScript passed (`2b2f74`). The joined test
applies migrations through 0075 and uses real creation, claim, status, approval
and quota services with synthetic signed JWTs and a mocked public-key response.
The separate routing test invokes the actual Operations entrypoint and checks
exact dispatch, disabled behavior, host rejection and neighboring-route staff auth.
These tests do not prove live Cloudflare policy, browser UI or full native-login
cutover. The underlying services' earlier transaction/authority tests remain
separate evidence; the joined fixture deliberately has an empty grant proposal.

Migration `0070_native_staff_pending_onboarding.sql` implements the local storage
foundation. Only pending version-1 rows may be inserted. Open reservations have
unique proposed staff IDs and normalized emails; claimed identities additionally
reserve the Access subject. Cancellation/expiration releases reservations without
deleting history. Invitation digests, proposed data and hashes, creator identity,
expiry and creation time cannot be rewritten. Claim identity/evidence becomes
immutable on claim. Every state transition increments the version exactly once;
terminal records cannot be changed or replaced.

Timestamps are canonical UTC millisecond strings with explicit chronological
checks. These are storage checks, not a trusted clock: the later services must
derive timestamps server-side, enforce current expiry, verify Access JWT identity
and invitation-secret possession, and check current scoped administration
authority. A stored creator identity and a syntactically valid proposal object
are not proof of authorization or live grants. The bounded immutable proposal
still requires full canonical scope/capability/ceiling validation before use.

Creation and claim reject existing live bridge/profile/admission collisions.
A legacy PA projection may independently create a conflicting bridge while an
invitation is pending; that does not claim the invitation and must block approval
until reviewed. No email-based adoption is implied. This migration does not
change PA projection behavior or create a `staff_users` bridge for an invitation.

Approval currently fails closed because the 0069 command service cannot issue
an onboarding-approval receipt. The future atomic command must create the exact
protected local bridge/admission/profile and checked grants, bind its receipt to
the onboarding ID, expected version, proposal and claim-evidence hashes, and then
transition the pending record. The existing schema join verifies receipt action,
target, approver and exact native identity; it is not that complete future
command's authorization/correlation proof. Pending storage must not be exposed
as a shortcut for admitting staff before that command and claim flow are tested.

The next administrator-command change must address a concrete ledger mismatch:
0069 currently requires every command target to reference an existing admission,
whereas invitation creation/cancellation must precede an admission. Do not insert
fake staff rows to satisfy that foreign key and do not introduce a receipt table
for every onboarding action. Extend the generic ledger with explicitly disjoint
live-staff versus onboarding targets, retaining concrete foreign keys and the
immutable proposed staff ID. Existing lifecycle receipts must retain their
live-admission deletion protection; onboarding receipts must bind to the exact
pending record, version, proposal and claim evidence. Fences and replay checks
must use the same target discriminator.

Migration 0071 implements the target-storage extension locally. SQLite cannot
make the existing required target column nullable through an ordinary ADD COLUMN.
The migration creates replacement commands, pending-onboarding and fence tables,
copies every original column, removes the old tables, and renames the replacements
inside one deferred-foreign-key D1 batch. It restores all 16 original 0069/0070
triggers and four explicit indexes without changing their definitions. The
circular pending approval reference is handled by rebuilding both referenced
tables together, not renaming the old parent and leaving a stale child reference.

Existing staff receipts default to `target_kind='live_staff'` and retain the
concrete admission foreign key. Onboarding targets instead require the exact
onboarding/proposed-staff pair through a composite foreign key, with no admission
row required. The shapes are exclusive. New guards bind the complete target
between fence and receipt, freeze fence target metadata, and give onboarding
mutations their own partial unique index in the same generic fence table.
Onboarding expected version zero is structurally available for future creation;
live-staff commands still require a positive expected version.

Migration 0071 alone is storage preparation, not invitation-command implementation.
Its closed-target guards reject all onboarding administrator commands. Existing
prestate, receipt, scope and approval guards still accept only their original
workflows. Before opening onboarding actions, implement their exact proposal,
version, current-authority/ceiling, mutation-consumption and result checks; the
0070 approval join must also change from a live-staff target to the exact
onboarding/proposed-staff pair plus claim/proposal evidence. Do not simply remove
the closed-target guards. Production application still requires full upgrade,
history-preservation and rollback acceptance, not only the mechanics probe.
Apply the entire file in one D1 migration transaction. An unexpected orphaned
historical fence or reference must stop the upgrade for review; do not drop,
repair by guessed identity, or skip such rows to get a green migration. Local
tests inject an error after the rebuild statements to verify schema and data
rollback, then compare all pre-existing staff trigger definitions after success.

The local 0072 successor opens only `staff.onboarding.cancel`. Its helper accepts
an exact invitation ID, expected pending/claimed version, current verified actor
and reason. The stored proposal must match the canonical parser and SHA-256.
Current target membership, active parents and explicit cancellation allow/deny
delegations are checked in the transaction, not inferred from who created the
invitation. Cancellation records terminal state without creating a live identity
or deleting invitation/claim history. Exact replay requires current authority.
The database requires an unconsumed, exactly correlated cancellation fence before
the state update, consumes it once, and validates the immutable receipt. Missing
claim-evidence JSON keys are distinct from explicit null. Allow, deny and parent
checks use separate triggers to stay within D1's expression-depth limit without
dropping checks. The three original live-staff trigger bodies remain unchanged
apart from their explicit target discriminator. Creation and approval remain
closed; no authenticated cancellation route or production migration is enabled.

The separate claimant transition does not use the administrator ledger: its
caller is not yet staff, and its immutable claimed row is the retained evidence.

### Local invitation-claim implementation

`claimNativeStaffOnboarding` accepts an exact version-1 request with onboarding ID,
expected pending version, invitation secret and a separately verified identity.
The future route must construct identity fields from verified Access JWT claims,
including the authorization deadline; browser-supplied `identity` fields are
never proof. The route still needs its dedicated audience/issuer verification,
isolated Access policy, bounded body, rate limiting and origin/CSRF protections
appropriate to the claim page. This helper does not verify JWTs or expose a route.

The version-1 invitation secret is exactly 64 lowercase hexadecimal characters,
representing 32 securely generated random bytes. Only the SHA-256 digest of its
UTF-8 representation is stored. `generateNativeStaffOnboardingSecret` supplies
fresh request-local cryptographic bytes for the trusted server adapter; its three
focused tests passed (`37bc9a`). The future authenticated adapter must generate
the secret once, retain it for exact retries, and deliver it only after confirmed
creation. It must not accept a browser-selected secret or log/store the raw value.
If an uncertain acknowledgement loses the caller-held secret, use an authorized
cancel/reissue workflow; a retry must not silently generate a different secret
for the same command. The claim helper compares fixed-size digests using the
runtime cryptographic timing-safe comparator, then pins the immutable pending
record in a single conditional UPDATE with RETURNING. Both invitation and verified
sign-in deadlines are checked again against the database clock at mutation time.
The 0070 claim trigger checks live identity and competing-claim collisions in the
same write. No access, account, membership or grant is created.

The retained evidence hash binds the domain/version, onboarding ID, proposed
staff ID, pending version, proposal hash, invited email, verified subject,
invitation digest, server claim time and sign-in deadline. Raw JWTs and raw secrets
are neither stored nor returned. The frozen result contains only onboarding ID,
result version and `claimed` state. Claim is single-use: a repeated claim or a
cancelled/expired invitation is rejected. An acknowledgement failure can happen
after the claim committed; it is not proof of rollback. The future UI needs an
authorized status/review path, not automatic creation of another invitation or
unconditional retry that treats the old secret as unused.

The local `readNativeStaffOnboardingClaimStatus` helper supplies that minimal
read-only recovery path. It requires the invitation secret and a currently
verified invited identity; claimed and approved records additionally require
the exact subject that claimed them. It returns only the onboarding ID, state
and version, never the proposal, staff profile, grants, secret or audit details.
Cancelled/expired records and expired invitation or sign-in deadlines deny the
read. Both the database clock and the post-read application deadline are checked.
An approved status is historical workflow state, not proof of current staff
admission: normal staff authentication must independently authorize entry.
After invitation expiry, use normal staff sign-in or administrator review; do
not extend the invitation or grant access from a cached status result.

The future claim page must distinguish uncertain submission from confirmed
claim. After a transport failure it may request this status with the same
invitation and fresh verified identity. `pending` permits offering the original
claim again; `claimed` means waiting for independent administrator approval;
`approved` offers normal staff sign-in. Status denial must not be presented as
proof that a claim rolled back. This helper does not create the authenticated
HTTP adapter, UI, rate limits or Access policy, and those remain cutover gates.

1. An authorized administrator executes `staff.onboarding.create`. It writes
   only the pending row and delivers a one-time secret out of band. Requested
   memberships and grants are stored as a canonical reviewed proposal attached
   to that row, not as live authority.
2. Pending claim uses a dedicated, minimal Cloudflare Access application or
   path policy that permits authentication for the exact invited email. Pending
   emails are never added to the main Operations staff Access group. The claim
   endpoint exposes no staff data and accepts only onboarding ID, one-time
   secret and the verified Access JWT.
3. Claim requires the secret digest, unexpired pending version, and exact
   normalized Access email. It records the JWT's opaque Access subject and
   consumes the secret transactionally. Email is therefore routing evidence,
   not identity proof by itself.
4. `staff.onboarding.approve` presents the claimed subject and impact summary to
   an authorized administrator. One atomic batch rechecks the pending version,
   uniqueness, current actor authority, live requested scopes and ceilings,
   then creates the local protected `staff_users` bridge, admission, native
   profile, memberships and grants plus audit. The bridge has
   `provisioning_source='local'` and `sync_protected=1`.
5. Failure rolls back every live row and receipt. Cancellation or expiry leaves
   durable pending history and cannot be reclaimed by replay. Approval never
   infers or creates a PA identity.

The pending-claim Access policy is a cutover prerequisite. Without it, a person
who is correctly excluded from the staff Access group cannot authenticate to
claim an invitation; adding pending email addresses to the main group would
prematurely expose the application.

## Authorization and transaction order

Every mutation uses one first-primary D1 session:

1. Validate a descriptor-safe, bounded canonical request.
2. Resolve active actor admission by exact Access subject.
3. Evaluate target scope with all matching memberships; inactive historical
   memberships supply no authority. An active membership with an inactive or
   malformed parent fails closed, and any matching deny wins.
4. For grant/delegation changes, prove the exact requested capability, effect
   and scope are within an effective ceiling.
5. Produce an impact snapshot with source row versions.
6. In one D1 batch, insert the fence, re-evaluate current admission, delegation,
   membership, parent and ceiling rows, apply exact expected-version writes,
   enforce last-admin invariants, and insert immutable audit.
7. Exact replay returns only when current authorization still permits it and
   never repeats a mutation. A disabled actor, changed subject, revoked
   delegation or revoked ceiling denies replay.

Scoped reads use the same evaluator. `staff.profile.read` returns only matching
targets. `staff.effective_access.read` explains live operational grants,
management delegations, ceilings, memberships, inactive parents and the allow or
deny rows that determined the decision. `staff.revocation_impact.read` reports
authority and onboarding that would be affected, exact row versions and whether
the command would remove the last control-plane administrator. Reads never use
legacy `isAdministrator` or PA ACL state.

Authorization rows belong to the acting administrator; inspection rows belong
to the selected staff target. They must not be conflated when those are different
people. Profile-only permission does not authorize returning a management-grant
snapshot. Conversely, management inspection does not implicitly grant reading a
target's login email. Every response shape must enforce the requested read
capability independently, including when the actor holds more than one.

Read loading must obtain a consistent native snapshot using prepared SELECTs in
one first-primary D1 batch. Copy verified input scalars before awaiting, retain
legacy/new table provenance, and reject over-limit current authority rather than
silently truncate a possible deny. Inactive history belongs to a separate history
view; accumulating old revocations must not consume the normal active-authority
budget. Malformed stored values and database failures must fail closed without
returning raw rows or query diagnostics. Returned version evidence is not a
reusable authorization token: later mutations must recheck it transactionally.

`readNativeStaffManagement` implements the current management-read foundation:
`staff.profile.read` returns only the selected native profile and version/status
metadata; the other two inspection capabilities return a frozen management-only
snapshot with `partial: true`, not a login email or the acting user's grant list.
This partial result is not the final operational effective-access report or a
complete revocation-impact assessment: directory grants, assignment/resource
effects, pending onboarding, last-admin outcomes and routes/UI must still be
composed under their respective authority. No caller may treat it as permission
to execute a mutation.

The read service hashes each raw row identity together with its legacy/new table
namespace into a bounded reference. A ceiling parent always references the new
management namespace. It loads both allows and denies, validates version/domain
and exact scope shapes, and fails closed on response errors, malformed values
or over-limit current rows. Inactive membership/grant history is not loaded in
this current-state view. A revoked target may be inspected by an authorized
active actor, but a revoked actor cannot reuse a previous read's authorization.

### Local target-scope evaluator boundary

`native-staff-management-policy.ts` evaluates a validated native actor, exact
capability, target memberships and management delegations. It returns matching
allow/deny IDs and scopes for explanation; it performs no database or network
work and does not itself establish that supplied rows are current or trusted.
The later loader must obtain complete authority rows from native storage, not
accept a caller-selected subset. Mutation fences still recheck current rows and
versions transactionally, with delegation ceilings and last-admin protection.

Inactive membership history supplies no current allow or deny scope and must
not block a staff transfer. An active membership whose area/division is invalid
does fail closed. Global and exact-staff scopes do not require a current division
membership; business-area and division scopes do. A matching deny overrides every
allow regardless of row ordering. Identity recovery never succeeds through this
normal target-scope evaluator.

A positive target-scope decision for a grant-management capability is only one
prerequisite, not permission to issue arbitrary grants. Likewise, onboarding
proposals must supply reviewed prospective target scopes through a trusted
adapter; a nonexistent staff ID alone is not an approved onboarding record.

## Last control-plane administrator

A surviving control-plane administrator is an active native admission with a
native profile and exact bound subject that has effective global allow, with no
active deny at any scope, for all of:

- `staff.onboarding.create` and `staff.onboarding.approve`;
- `staff.admission.disable`;
- `staff.membership.manage`;
- `staff.directory_grant.manage`;
- `staff.admin_delegation.manage`.

Action allows alone are insufficient. The candidate must also have effective
global creation ceilings that can:

- grant and revoke every contract-version-1 native directory permission at
  global scope, for both allow and deny effects; and
- grant and revoke all six control-plane capabilities above at global scope,
  for both allow and deny effects.

This is the ability to replace and safely constrain an administrator, not proof
of business ownership or identity-recovery authority. Admission disable,
delegation/ceiling revocation, and any change that would make the final candidate
ineffective are blocked by an in-transaction SQL predicate. Impact display is
advisory; the SQL fence is authoritative.

The candidate-wide proof must use global management parents. A global-looking
ceiling attached to an exact-person or division-scoped parent cannot count as
global administration merely because that parent matches the candidate today.
Check each required capability against both create/revoke operations and both
allow/deny grant effects. A candidate with only creation authority cannot safely
replace or constrain an administrator. Do not combine partial authority from
different people into one fictional surviving administrator.

`native-staff-control-plane-policy.ts` implements this advisory candidate proof.
Its inputs must come from trusted complete native rows, including a native
profile with the candidate's permanent staff ID. It checks six global actions
and 44 capability/effect/operation combinations. Relevant active deny ceilings
attached to scoped active allow parents still disqualify global administration;
filtering them out while selecting global allow parents would be incorrect.
Its result is not a grant, a bootstrap approval or a database mutation fence.

Migration `0068_native_staff_control_plane.sql` projects independently complete
candidates from current stored rows, including subject binding and admission/profile
versions. It preserves the original 0061 action meaning and adds no grants or
blocking triggers. The SQL view assumes schema-valid rows from validated writers;
its basic subject checks do not replace the runtime Unicode validator or verification
of the current Access identity. A returned candidate is not an authenticated caller.
Every required action and all 44 tuples must belong to the same person. Any
nonempty relevant deny ceiling blocks at least one required tuple, including when
its active allow parent is scoped rather than global.

The local transaction test uses a test-only assertion table to prove that two
competing admission removals cannot both commit when the candidate count is
checked inside each D1 batch. This does not implement production command
authorization, audit, replay, or coverage of all management mutations.

Acceptance must compare pre-change and post-change snapshots inside the same
transaction. Test each of the six missing control-plane actions, each missing
ceiling operation/effect combination, scoped parents, scoped denies, admission
disable, missing profile, subject mismatch and concurrent removals. The existing
0061 two-action SQL guard remains its original contract; it is not evidence that
the expanded invariant is enforced. The replacement must cover ceiling and
delegation edits as well as admission changes before any new route is enabled.

The current version-2 bootstrap administrator has only the two migration-0061
actions and therefore does not satisfy this new invariant. Before management
routes are enabled, a separately reviewed out-of-band upgrade must install the
new global actions and ceilings while preserving the old rows unchanged.

Identity recovery is the independent escape hatch. A valid out-of-band recovery
approval atomically rotates admission subject and profile email/version and
writes a receipt. It never reactivates a disabled admission, never grants
authority and never requires multiple employees. Small-owner deployments must
maintain a separately trusted recovery channel and rehearse it before cutover.

## Invariant acceptance matrix

| Invariant | Required acceptance evidence |
| --- | --- |
| Pending isolation | Pending and claimed invitations create no `staff_users`, profile, admission, membership or live grant rows; PA snapshots/webhooks have nothing to match. |
| Claim containment | Main staff Access group excludes pending email; dedicated claim policy, JWT email and one-time secret are all required; replay and expiry fail. |
| Atomic approval | Inject a late grant/delegation/audit failure and prove bridge, admission, profile, membership, grant and receipt all roll back. |
| Native-only identity | Onboard an Operations-only employee with no PA row; PA email/status events neither create nor alter the identity. |
| Scope and deny | Global, business-area, division and exact-person allows work only for matching targets; any matching deny and every inactive parent fail closed. |
| Use is not grant | An actor who can use a directory capability but lacks its ceiling cannot grant it; a scoped ceiling cannot create a broader or different capability. |
| Delegation subset | Admin delegation creation/revocation requires both target authority and an effective ceiling covering exact capability, effect and scope; self-escalation fails. |
| Existing meaning | Migration-0061 `staff.profile.edit` cannot change login email/subject and `staff.admission.disable` cannot acquire onboarding or grant power. |
| Optimistic concurrency | Stale expected versions, zero-row mutations and changed authorization cannot mint audit or receipt rows. |
| Replay | Exact replay is read-only and current-authorized; actor disable, subject rotation, delegation/ceiling revocation or approval revocation denies it. |
| Last administrator | Concurrent admission/delegation/ceiling removals cannot eliminate every effective global control-plane administrator; action-only candidates do not count. |
| Recovery boundary | Ordinary routes cannot issue recovery approval; exact approved recovery rotates identity without activation or grants and stale/revoked approval fails atomically. |
| Scoped inspection | Profile, effective-access and impact views reveal only authorized targets and identify the exact allow/deny/ceiling rows and versions used. |
| Historical durability | 0061 rows and receipts remain unchanged; new audit is immutable and records contract version and canonical hashes. |

## Delivery order

1. Add the next unused management migration, pure catalog/scope/ceiling evaluation and full migration
   upgrade tests.
2. Add generic transactional commands and scoped read/impact services, including
   concurrency and injected-failure coverage.
3. Add pending create/claim/approve/cancel services and the isolated Access claim
   boundary; prove an Ops-only account end to end.
4. Add out-of-band recovery approval installation/execution and rehearse
   lockout recovery.
5. Install reviewed control-plane actions and ceilings, then add authenticated
   routes and UI.
6. Activate native login and native Access-group calculation only after joined
   acceptance. No PA authority fallback remains enabled.

## Local invitation UI checkpoint

The disabled-by-default invitation HTTP boundary and isolated creation, claim,
and review screens are implemented locally. Creation uses authorized membership
and grant-option lookups; no grants are preselected, and all mutations recheck
current authority. Invitation secrets require explicit reveal and are kept only
in page memory. A lost create acknowledgement pins the original command for
retry rather than issuing a second invitation.

Acceptance on this checkpoint: 33 API/D1 tests and 76 desktop/mobile browser
tests passed, with TypeScript/build passing and desktop/mobile screenshots
reviewed. See the migration plan for exact evidence and test scope. This does
not supersede delivery steps 4–6: recovery, complete control-plane authority,
native login and live acceptance remain required. Resource/existing-person
scope searches and general staff-management UI are also still pending.
