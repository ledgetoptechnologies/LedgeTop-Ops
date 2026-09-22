# Native outage-email reconciliation

Status: implementation in progress; no production settlement or real mail send.
This completes recovery for the existing per-instance outage alert, not PA
financial notification handling. PA retains its financial email ownership.

## Current browser composition checkpoint

The local entry point now selects `/administration/connections/alerts` directly,
clears query/hash input, and delegates shell ownership to the reconciliation
wrapper. The advisory native navigation list includes Alert recovery only when
its dedicated surface is returned. A reconcile-only navigation regression was
added; no monitor or permission-management link is implied.

The backend mount, opaque actor binding, browser transport, recovery wrapper and
panel now pass a local TypeScript check (`4b7611`), 24 focused API/transport/
navigation cases (`69b4a0`), all 48 staging checks (`bba470`) and a complete
Operations production build (`6a2438`). Six desktop/mobile browser cases passed
(`35ae52`) after correcting a synthetic source ID. The fixture was then upgraded
to the real `NativeWorkspaceShell`: six more cases passed (`79f008`), including
the shell's actual expiry timer, reauthentication, exact-command retry and a
different-actor refusal. These are synthetic browser and provider responses,
not deployed Access, current operator grants or real SMTP acceptance.
An added Worker mount regression passes three cases (`150717`): only exact
reconciliation routes dispatch, its flag is independent from monitor control,
and unsupported descendants do not enter legacy authentication. TypeScript
passes again after that test (`d444e4`).

The separate `NATIVE_INTEGRATION_ALERT_RECONCILIATION_ENABLED` flag is checked in
as `false` and prohibited for staging activation until its dedicated authority,
operator evidence and release gate are proven. No production flag changed.

## Reconciliation list acceptance — September 13

The dedicated reconciliation-only reader and HTTP list adapter are implemented
locally. Root's final joined run passed all 11 tests in two files (`999732`,
72.43 seconds), including the final post-projection identity-expiry check.
Three real-D1 reader cases and eight HTTP cases exercise the current dedicated
reconciliation grant, bounded 25-item pagination (including 27 seeded incidents),
and native request handling. The initial list-GET Origin-policy mismatch was
corrected before this final passing run.

The returned items contain exact incident/source identities, revision and claim
witnesses, category and timestamps, not lease tokens or recipient addresses.
This is still unmounted: operator UI, production configuration and live
acceptance remain incomplete. No email was sent or production incident settled.

Parser checkpoint: four focused pure tests pass (`3410a1`), after root corrected
tests that wrongly rejected syntactically valid alternate command IDs and epochs.
The parser validates and detaches a tuple; only the database executor can prove
that tuple identifies the current existing incident. Type checking also passed.
That parser result alone proves no database execution, HTTP route, operator
settlement or real email.

## Executor review checkpoint

The unmounted executor and migration 0093 now exist locally. The initial focused
database suite passed seven cases (`fd4948`, 169.93 seconds). Source review
confirms a before-state fence and one batch containing the head/alert changes,
existing alert event and immutable attributed command receipt. Live activation
and HTTP exposure remain prohibited until local acceptance and release review.

The follow-up source revision now uses one primary SQL statement for all
preflight witnesses, replacing the separate reads identified below. TypeScript
passed (`ceac9a`). The expanded twelve-case full-chain D1 suite passed
(`d051af`, 286.01 seconds). These changes do not imply release approval.

Review requirements addressed by the follow-up source and passing suite:

- Consolidate preflight reads into the promised coherent snapshot. The initial
  implementation launches separate actor, grant, head, alert and receipt queries;
  a session alone does not make those separate reads one database snapshot.
  The commit fence is necessary but does not justify claiming snapshot parity.
- Exercise an explicit active reconciliation deny and admission/profile changes
  between preflight and commit, not only revoked allow before invocation.
- Exercise an actual unattempted leased claim and a changing claim/head/lease.
  Merely changing an alert revision proves stale-version rejection, not rejection
  of a matching unattempted lease.
- Verify revocation between initial replay reads and the final receipt gate.
  Historical receipt possession must not bypass current authority.

The suite now covers those initial acceptance gaps, including current authority
at final replay disclosure. HTTP/browser integration, staged release rehearsal
and production acceptance remain outstanding. No production migration, grant or
real email changed.

## Evidence and missing boundary

The unmounted HTTP adapter now passes seven focused mocked boundary tests
(`6cdffa`) and type checking (`a07441`). It has a separate default-off gate,
native authentication, purpose-specific CSRF, bounded JSON, rate limiting and
typed denied/conflict/unknown responses. Expiry after execution is not reported
as proof that a dispatched command rolled back.

The operator workflow is not complete: the existing monitor reader requires
`integrations.monitor.manage` and returns lifecycle configuration, not alert
claims. An internal incident reader is not independently authorized. A dedicated
`integrations.alerts.reconcile` reader is being implemented to expose only bounded
current expired attempted claims and their exact revisions, without lease tokens,
recipient addresses or SMTP transcripts. Reconcile-only staff must not need
monitor-management rights just to discover an incident.

- `project-alpha-api-v2-incident-alert-dispatch.ts` retains an attempted lease
  when provider acceptance or its database acknowledgement is uncertain.
- `project-alpha-api-v2-incident-alert-store.ts` deliberately refuses automatic
  reclamation of that attempted lease. Its internal `sent`/`failed` transitions
  are scheduler primitives, not authorized operator commands.
- That store does not independently authenticate native operators, persist an
  operator command receipt, or preserve typed unknown outcomes. Do not mount it
  directly behind an administration button.
- Migration 0088 has immutable alert events and revision checks, but no native
  operator identity or reconciliation command ID. The replacement needs an
  attributed atomic boundary, not a browser-supplied lease token.

## Operator decision

### Browser workflow implementation contract

- Discover incidents using the reconciliation-only API, not the monitor-management
  endpoint. A reconcile-only operator must be able to reach this screen without
  gaining connection configuration or grant-management privileges.
- Show source, category, attempt time and incident/claim reference. Describe
  provider acceptance accurately; never call it proof of inbox delivery.
- Require a reason and explicit confirmation that confirmed non-acceptance allows
  a later scheduled retry. “Still unknown” leaves the incident untouched.
- Capture one immutable command before dispatch. After a timeout, unreadable
  response or expired session, retain that exact command for receipt recovery;
  never silently generate a replacement or change its outcome/reason.
- Clear expired authority and incident display. Fresh authentication and current
  server authorization are required for replay; cached data grants no access.
- The shared navigation shell unmounts its children when its session expires.
  Therefore panel-local state alone cannot preserve an unresolved command.
  Keep recovery state in an in-memory controller above that shell; do not put
  it in URLs, browser persistent storage or hidden DOM. Store no CSRF token.
  The reconciliation session supplies a purpose-specific opaque actor binding,
  derived server-side from the verified staff identity and source authority.
  Only a fresh session with the same binding may redisplay or retry its command;
  a different signed-in actor must not see the old reason or incident details.
  The executor still independently authorizes every replay. Acceptance must
  exercise actual shell unmount/remount, not just the panel's expiry timer.
- Keep provider addresses, lease tokens, cookies and raw mail diagnostics out of
  the browser response, receipts and logs. The UI must not accept a caller-supplied
  recipient or connection URL to fetch.

- **Confirmed accepted:** evidence establishes the email provider accepted the
  original attempt. Settle it as `sent`; never send another copy for that claim.
  Provider acceptance is not proof that the recipient received or read it.
- **Confirmed not accepted:** evidence establishes the original attempt was not
  accepted. Settle as `failed`, returning it to the existing backoff mechanism.
  This decision allows a future scheduled send; the reconciliation request itself
  sends nothing. Require an explicit warning and confirmation of that consequence.
- **Still unknown:** leave the lease and attempt unchanged. A timeout, missing
  inbox message, or elapsed lease is not evidence of non-acceptance.

Record the operator's bounded reason and reconciliation time. Do not claim the
reconciliation timestamp is the original delivery timestamp. Never place raw
SMTP transcripts, credentials, recipient details or tokens into public receipts.

## Command and authority

The exact command contains an immutable command ID, existing incident identity
tuple, expected head/alert revisions, incident/claim sequences, `sent` or `failed`
outcome, and reason. The tuple selects an existing incident; it cannot configure
a PA connection, choose a recipient or initiate a network request. Reject extra
authority, lease, recipient, credential and caller-clock fields.

The executor derives the actor, current time, current native admission/profile,
and dedicated `integrations.alerts.reconcile` allow/deny witnesses itself. PA
roles, monitor management and grant management are not interchangeable with this
capability. The pure parser is not an authorization decision.

Use a fresh primary snapshot for preflight and receipt reads, then an atomic
before-state fence for mutation. Require the exact unsettled attempted claim:
matching incident/head/alert revisions, matching claim, leased status, attempted
timestamp present, sent timestamp absent, and lease expired. Recheck native
subject/admission/profile versions, deadline, active allow and no active deny
inside the same database transaction as the state changes and immutable receipt.

Reuse the existing transition semantics without calling the old executor in a
separate transaction. Fence the exact before state, update head and alert, append
the existing alert event, and write the attributed receipt atomically. A matching
after state alone must not attribute another writer's change to this command.

## Recovery and acceptance

- Replays use the same immutable command ID and complete request hash, require
  the same actor and current authority, and return historical receipts only.
  A receipt never substitutes for a fresh read of current incident state.
- Distinguish denied authority, authorized stale-state conflict, and an unknown
  post-dispatch outcome. Do not infer rollback from a timeout or SQL error text.
- Preserve exact unresolved command identity across session expiry and failed
  refresh; clear expired authority and sensitive display, not retry identity.
- Test both outcomes, unknown no-op, lost acknowledgements, exact replays,
  changed hashes, late audit failure rollback, and actor/grant/lease/claim/head
  changes between preflight and commit using the complete local D1 chain.
- Verify the command itself never sends mail; failed settlement may only become
  eligible through the existing scheduler's current configuration and backoff.
- Recovered/disabled or superseded incidents need explicit treatment: do not
  manufacture a new alert or revive an obsolete incident to resolve history.
  The initial executor should reject stale claims until a separate historical
  annotation policy is defined, without blocking native Operations workflows.
- Operator UI, release inventory, staged migration rehearsal and live acceptance
  remain required. No bootstrap, permissions or production flags are implied by
  implementing this workflow.
