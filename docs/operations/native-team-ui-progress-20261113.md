# Ops-native Team UI progress

This is a source checkpoint, not a release receipt or completed employee-management feature. Merger owns integration, staging, provider configuration and production releases. No live permissions, feature gates, migrations or staff records were changed.

## Current onboarding successor

The preserved c8ed63da checkpoint below is extended with a staging-only Team
invitation panel and a recipient confirmation page at `/staff/onboarding` that
mounts before the existing staff-session check. Explicit actions create, reveal,
review, approve or cancel an invitation. Every mutation retains its exact
command snapshot after an uncertain result. Claim approval remains independently
authorized on the server and always creates an empty-ACL employee; the UI does
not grant operational roles.

Invitation links carry only the onboarding ID and secret in a fragment. The
fragment is captured once and removed before React renders, including under
StrictMode. Neither secrets nor commands are persisted or sent by email. The
claimant API uses its separate audience/token header, never a staff-session
fallback. A consumed claim remains one-use: a lost acknowledgment may require
the inviter's review, and the page does not turn a later 403 into success.

An exact create receipt can now be reconciled after its expiry threshold;
author/subject/hash binding and current identity remain checked, while new
invitation creation still enforces the original 60-second/seven-day window.
Reconciliation neither extends expiry nor recreates an invitation or secret.
Expired pending-record cleanup/discovery is not implemented by this change.

Team also offers explicit username loading/editing/clearing through the existing
admin API. Identifier changes never grant eligibility. That older endpoint has
no command/revision contract, so ambiguous writes are not retried automatically:
a fresh read and explicit acknowledgement are required before another edit.

Actual focused source validation: 24 dependency-free Node checks passed, zero
failures/skips; syntax checks passed for changed non-JSX TypeScript sources and
new D1 test source. Independent source review found no new concrete blocker
after fixes. The new D1 expiry regression is written but unexecuted. Full Ops
TSC, React/TSX build, component/browser and end-to-end staging checks are still
required for this successor. Earlier c8ed/ff074/8896 results do not transfer.

Deployment remains held: the separate staging claimant Access application,
policy and audience have not been configured/verified by this source work.
Onboarding flags stay unchanged; production recipient claim/approval remain
unsupported by the existing staging-only backend boundary. Native ACL mutation
executors/HTTP routes for memberships, directory grants and admin delegations
are still missing; a capability catalogue or partial read is not a working
editor. Do not use the sync-protected legacy bulk override as a substitute.
Documents/equipment/custom fields remain a subsequent slice.

## Implemented in this slice

- Dedicated same-origin native Team transport obtains the native lifecycle CSRF token instead of passing through the generic API helper, which replaces mutation tokens. Session, scoped profile and versioned display-name/archive/restore responses are checked. Requests and JSON responses are bounded; redirects and HTML login responses fail closed.
- Explicit profile loading and display-name editing use the profile version. Archive and restore use the admission version; no hard delete exists. Login email is read-only and this screen does not implement administrator email replacement or recovery.
- A submitted command is captured before the first asynchronous call. Unknown outcomes retain the same immutable command ID, body and expected version; neither read-only refresh nor a later pre-send failure authorizes a replacement command.
- Controller eligibility is an explicit separate control with its own readback token, expected revision and reviewed target admission version. A username alone never grants eligibility. Reads that fail are not rendered as successful empty/ineligible results. Re-grant remains available after an admission-version change, even when an earlier allow record exists. The five-field HTTP command and v2 idempotency hash reject a pre-archive UI review against a restored admission; the existing SQL fence receives that same reviewed version. No SQL migration or Logs protocol changed.
- Team description and roster badges no longer say PA manages all staff. Protected Owner is based on the fixed protected owner or an actual global owner role, including local owner assignments. Sync immunity is not ownership. Existing legacy ACL mutation behavior and deny precedence are unchanged.

## Validation and limits

`node --test apps/operations/test/native-team-api.node.test.mjs apps/operations/test/native-team-owner-roster.node.test.mjs`: 14 passed, zero failed/skipped. Includes lost acknowledgment, exact native token use, stale revision/admission preservation, matching receipts, denied/default-off paths, bounded UTF-8 bodies, definite rejection versus ambiguous mutation responses, and the actual roster owner SQL predicate exercised with in-memory SQLite. This is not D1 evidence.

Node syntax checks passed for the new API client, both changed eligibility Worker modules and the updated D1 test source. No full Operations TypeScript check, React build, DOM/component runtime, D1/Worker suite or live Team mutation has run for this slice. Independent source review found two issues (admission review fencing and permanent locks on definite rejections); both were fixed and the reviewer found no new concrete blocker on re-review. Source review is not runtime acceptance.

The existing immutable eligibility sender ff074 and Logs consumer PR560 require their own paired qualification and activation review. This Team successor changes the sender HTTP command contract and requires separate validation; no earlier ff074 result transfers to it. The D1 archive/restore regression now includes a stale pre-archive UI request, but this new regression has not executed.

## Original c8ed remaining-work checkpoint (superseded above for onboarding and username source)

- Invitation creation/reveal, recipient claim, independent review/approval and cancellation UI, respecting the backend's separate default-off and staging-only gates.
- Controller username editing through the existing authorized API, without treating a username as an access grant.
- Complete native ACL management and verification; this slice does not grant access to new employees or replace scoped delegation rules.
- Documents, equipment and custom profile fields remain a subsequent slice. Document retention and employee archival are separate requirements.
- Full source qualification and staging acceptance, followed by reviewed release with actual 48-hour frontend asset preservation. No production readiness claim follows from these focused tests.

General Hub task writes are unavailable to this identity. This durable handoff is NOT recorded as a general Hub task and must be reconciled when the supported workflow is available.
