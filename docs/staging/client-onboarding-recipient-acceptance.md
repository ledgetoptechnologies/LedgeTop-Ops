# Client onboarding recipient staging acceptance

This is a bounded, synthetic staging-only acceptance window for the native
Operations invitation, Client recipient form, and read-only staff review in
draft PR119. It is **not** client-portal enrollment, a Project Alpha write, or
approval of a canonical customer record. Keep production Workers, databases,
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
   scope, and rendered fields. There is no approval/rejection endpoint in this
   PR. Verify no native Directory client, PA outbox item, entitlement, portal
   membership, public link, or email was created by this sequence.

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
