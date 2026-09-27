# Client onboarding recipient staging acceptance

## September 26 staging preflight result

PR119 source `12aeff925425d310f5a0f3afd4a3120eec81beef` is deployed only
to staging as Client version `f00c3a7f-307a-4ec1-802e-a15039173b3b`
and Operations version `4892f7b6-81b8-4a47-9d9a-28642681f52c`, each at
100%. Onboarding and recipient flags remain off. Staging-only Delivery secrets
were installed through inactive versions; their values were not recorded.
The synthetic protected-share wrong-code, correct-code listing, and revoked
page checks passed; file download/range behavior remains unverified because
the in-app browser blocked navigation to the download endpoint. No recipient
invitation, submission, review, approval, client entitlement, or PA write was
exercised in this preflight. The remaining steps below are still required.

A later pre-window check prepared a new ignored provision/revoke packet and
uploaded reviewed inactive acceptance versions (Ops
`47138519-b0b1-48fe-80c7-201332375cd5`, Client
`736635c7-4547-4637-97f1-7aef6a2e06f6`). They were **not deployed**,
and the packet was **not applied**. The in-app browser still blocks a no-secret
`/onboarding/` URL before navigation (`ERR_BLOCKED_BY_CLIENT`), whereas the
disabled staging Worker itself returns 404 over an unauthenticated GET. Resolve
the browser-side acceptance path before opening the time-bounded authority
window; regenerate expired packet timestamps and recheck live D1 state then.

September 26 follow-up: the signed-in Operations staging administration page
loaded successfully and still reported primary sync disabled and Client workflow
gates unverified or blocked. A new, no-secret synthetic UUID route was then
opened in both the Codex in-app browser and a connected Microsoft Edge session.
Both blocked navigation to the Client staging `/onboarding/:invitationId` path
with `ERR_BLOCKED_BY_CLIENT`; Edge displayed its own blocked-page message, not
an Operations or Client application response. Client staging `/` remained
reachable and showed its intentionally disabled portal. This independently
reproduces a browser-side access blocker, not a failed recipient API response.
Do not weaken browser protection or substitute a token-bearing shell request
to satisfy this UI gate. The reviewed inactive Worker versions remain off and
no invitation or authority packet was applied. A normal browser navigation to
a no-secret synthetic path must succeed before the narrow window below opens.

September 26 business-approval checkpoint: draft Ops PR120 at
`5359c8b767107a0cbffa8efed8aaa034b61e03dd` passed all ten exact-head CI
jobs and a changed-source security review with no findings. This is source and
CI evidence, **not** staging acceptance: the active staging Worker versions
above still run older code with onboarding flags off. PR120 adds no migration;
its organization-plus-client approval relies on existing `0083` and `0134`.
Before a positive business approval, upload and inspect the exact PR120 Ops
staging version with flags off, verify migration state through `0140`, resolve
the no-secret browser navigation block, and prepare a fresh, independently
reviewed provision/revoke packet containing both `directory.profile.edit` and
`directory.identity.link` for one chosen staging business-area scope. The
profile-edit-only packet below must not be reused. Do not infer PA sync, portal
enrollment, delivery/public-link parity, or production readiness from CI.

Later September 26 source checkpoint: PR121 recipient-bridge head `7811c4b`
passed all ten CI jobs and an exact-diff security review with no findings.
The local combined draft also passes focused recipient and approval tests;
it has **not** been published or staged. The staging secret inventory now
requires `CLIENT_ONBOARDING_HANDOFF_KEYRING`, but no keyring value was created
or enabled. The approval route still creates native-only records with empty PA
destinations. Explicit, authority-fenced PA enrollment and a subsequent
verified-identity portal membership remain separate implementation and live
acceptance gates; neither follows from approval alone.

September 26 local enrollment draft (not published or deployed): staff approval
can now select zero, one, or both configured PA source IDs. The server derives
each destination from the configured API-v2 connection and live Directory
inventory; it never accepts a browser-supplied PA URL, application ID, or
authorization generation. The approval decision persists the exact selection,
and a retry reuses that decision without silently selecting a different source.
Consumer enrollment passed an isolated migrated-D1 approval test for each
selected-source shape, including replay. Business enrollment requires a
deferred child-intent step after the organization is acknowledged by PA; this
step and its permission-revocation and queue-liveness tests remain under local
review. None of this is staging evidence or client portal access. Existing
public links remain outside the new approval path. Keep all onboarding and
portal flags off until the full safety review and the entry gates below pass.

This is a bounded, synthetic staging-only acceptance window for the native
Operations invitation, Client recipient form, and staff review in draft PR119.
Although that branch now contains a guarded approval route, this window does
**not** exercise approval: its authority packet grants profile edit only, not
identity link. It is **not** client-portal enrollment, a Project Alpha write,
or approval of a canonical customer record. Keep production Workers, databases,
Project Alpha instances, existing public links, and Access policies unchanged.

## Entry gates

1. Pin and record the exact Ops and Client staging Worker versions and their
   current rollback versions. Confirm both bind only to staging D1, and the
   Client `CLIENT_ONBOARDING_RECIPIENT_BRIDGE` service binding targets the
   staging Ops Worker. Confirm Ops migrations through `0140` and no pending
   migrations. Keep all new onboarding flags `false` until every gate passes.
2. Select one existing active staging business area and a **new**, unlinked
   synthetic client proposal. Do not use a real person, existing client,
   organization fixture, PA destination, or public Delivery link.
3. Prepare and independently review a governed staging native-authority
   provision **and revoke** packet for the signed-in staff actor. It must
   reactivate the exact current admission/profile and grant only
   `directory.profile.edit` for the chosen business area, with deny precedence.
   Do not use raw D1 mutation or broaden to Project-sync, enrollment management,
   identity-link, or portal-access authority for this submission/review test.
   Record sanitized versions/receipts; never record the Access subject.
4. Confirm the existing `OPERATIONS_SESSION_SECRET` is present. Prepare a
   staging-only `CLIENT_ONBOARDING_HANDOFF_KEYRING` with one active key ID and
   a randomly generated 32-byte key represented as 64 lowercase hex digits.
   Keep the key and recipient handoff fragment out of source, logs, PRs, and
   release evidence. Use an inactive version/inspect/deploy workflow rather
   than an implicit production or unreviewed Worker deploy.
5. Verify that client portal, invitation email, authenticated delivery,
   viewer, prefill, and public-share flags remain at their prior values. This
   test must not grant access or send a launch invitation. Capture a
   synthetic staging public-share baseline, including valid, invalid-password,
   expired/revoked, and resumable range behavior where the existing fixture
   supports each case. Never use a real client share URL as test evidence.

## Narrow test window

1. Temporarily set only Ops `CLIENT_ONBOARDING_ADMIN_ENABLED=true`, Ops
   `CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED=true`, and Client
   `CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED=true`. Set the Ops admin origin
   to the exact Ops staging origin. Inspect the resulting versions and
   bindings before routing traffic to them.
2. From the signed-in staff browser, issue one short-lived, new-client
   invitation for the chosen business area with division unset. Capture only
   the invitation/command identifiers and request digest. Reveal its handoff
   exactly once. Build the recipient URL with the fragment locally; never put
   that URL in documentation, screenshots, chat, telemetry, or email.
3. Open the recipient URL in Client staging. Confirm the fragment is scrubbed
   before the application sends a request. Submit a synthetic consumer profile
   with no organization fields. Record only the submission identifier and
   fields fingerprint. Retry only with the same in-memory submission ID when
   testing idempotency; do not create a second proposal accidentally. If the
   browser blocks the route before navigation, stop and record that as a
   separate access/browser acceptance blocker. Do not paste the fragment into
   a different tool or claim submission/review passed.
4. In the staff read-only review panel, fetch that submission and compare its
   invitation ID, submit time, fingerprint, exact proposed business-area
   scope, and rendered fields. Do not invoke the approval route in this
   profile-edit-only window. A later positive approval test needs a separately
   reviewed, scoped `directory.identity.link` grant as well as profile edit;
   it must not reuse this packet. Verify no native Directory client, PA outbox
   item, entitlement, portal membership, public link, or email was created by
   this sequence.

## Close and evidence

1. Turn the Client recipient flag off, then the Ops recipient flag off, then
   the Ops admin flag off. Read back deployed versions and verify the three
   routes fail closed. Keep unrelated staging and public-link flags unchanged.
2. Apply only the pre-reviewed authority revoke packet after review is
   complete; recheck inactive admission/grant and absence of active work.
   Retain immutable invitation, submission, audit, and migration evidence.
3. Retain the keyring under controlled staging-secret custody until no pending
   handoff needs recovery, or remove it through a reviewed versioned secret
   update. Do not roll back migration `0140` to clean up the test.
4. Record sanitized identifiers, Worker versions, status codes, D1 counts,
   duration, retry results, and rollback readback. Never record credentials,
   handoff fragments, private profile values, or raw tokens. A passing test
   advances only recipient submission/review readiness; native approval,
   two-instance PA sync, and real portal authorization remain separate gates.
   Repeat the synthetic public-share checks against the deployed versions and
   compare with the baseline; route-diff inspection and local unit tests alone
   are not live-link parity evidence.
