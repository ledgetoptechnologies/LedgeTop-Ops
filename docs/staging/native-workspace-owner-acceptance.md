# Native workspace owner staging acceptance

This path prepares an explicitly selected Operations-owned client workspace.
It does not enroll a recipient, share a folder, create a public link, or mutate
Project Alpha. Production registration and production access remain unchanged.

## Configuration

- The staging template provides the private `OPERATIONS_PORTAL_WORKSPACE_PUBLICATION`
  binding to `ledgetop-clients-staging` / `OperationsPortalWorkspacePublicationIngress`.
- Both `OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED` and
  `OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED` default to `false`.
- Enable both only on the exact Ops staging host with the existing native
  authority configuration and `OPERATIONS_SESSION_SECRET`. Preserve all other
  deployment variables, bindings and secrets.
- The handler uses the existing reservation, snapshot/publication, invocation
  and dispatch services. It does not insert authority heads directly.
- `scripts/staging-native-workspace-acceptance-profile.mjs` provides a pure,
  validated configuration transformation for paired acceptance: the two Ops
  gates above plus Client `CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED`.
  It changes only those three flags, verifies the private staging destination,
  rejects partial activation and unrelated drift, and performs no file writes
  or deployments. Recipient service-home activation is a separate profile.

## Safe acceptance order

1. Verify current native admission/profile versions and deny-aware grants.
   Staging owner role alone does not replace the domain permission checks.
   Never apply an old authority packet against a different current generation.
2. Create/review a synthetic native client using the existing onboarding flow.
   Use explicit source selections; native-only approval uses `sourceIds: []`.
   Approval still requires its current profile-edit and identity-link authority.
3. Open `/administration/client-portal/operations-workspaces` on Ops staging.
   Enter the exact root record ID/version and explicit target, client-authority
   and workspace IDs. An organization root has a null relationship version;
   a standalone client requires its current relationship version.
4. Reserve and publish. Record the non-secret operation IDs and acknowledged
   revision. A `retry`, conflict, or uncertain transport result is not success.
   The UI retains the exact request for replay and pre-fills the publication
   recovery ID. Do not generate a replacement workspace because an observation
   timed out. Recovery uses a new audited invocation for the same publication.
5. Verify the staging Client publication receipt and exact snapshot. In the
   owner page, load the explicitly selected shared project by workspace target
   and external project ID. Confirm its exact destination division/base prefix
   using the returned project version and complete prior association proof.
   The server derives the confirmer and confirmation timestamp; these are not
   editable authority fields. Then reserve only the selected synthetic folder
   (`reserve-folder-and-publish`), supplying workspace/publication revisions,
   selected prefix, reservation ID and client folder binding ID. Project/base
   confirmation fields are read-only, loaded from the authorized server proof.
   The domain service independently rechecks these inputs and current authority.
   Folder revocation (`revoke-folder-and-publish`) checks the exact reservation
   revision and republishes the complete snapshot at the explicit publication
   revision. Neither operation changes a public delivery link or deletes files.
   Retained uncertain requests may replay only while the visible workspace or
   folder selection still exactly matches their original semantic fields.
   If a selection changed, restore it or use publication recovery rather than
   silently submitting the old retained operation under a new project.
6. Enroll the verified synthetic recipient and test sign-in, selected service
   visibility, selected file access, unauthorized identity denial and revocation.
   Workspace publication alone grants no recipient access.
7. Disable temporary setup flags when acceptance is complete. Preserve audit
   records and document rollback/recovery; do not alter existing public links.

## Evidence boundary

Local adapter and scaffold tests are not live sign-in/data proof. Full PA–Ops
reconciliation, retry/idempotency and portal acceptance remain release gates.
Only after those gates pass should the owner production PA update checkpoint
be requested.

## Local paired configuration checkpoint — 2026-10-02

- Reconstructed the missing default staging configurations with the reviewed
  scaffold and existing validated non-secret values; no existing config was
  overwritten. Full staging preflight passed.
- Generated and checked the paired native recipient service-home profile.
- Rendered the separate workspace profile through its pure builder, wrote the
  pair locally, and revalidated the actual on-disk files against the bases.
- All seven generated staging config files are ignored by Git, including the
  scaffold's separate ops-sync base. No config or private values were published.
- Client local build passed. Wrangler 4.118.0 dry-runs passed for both apps in
  both windows (four bundles). Ops dry-runs also built the existing local
  renderer image; no image upload or remote resource change occurred.
- Workspace profile files are `apps/client/wrangler.staging.native-workspace-acceptance.json`
  and `apps/operations/wrangler.staging.native-workspace-acceptance.json`.
- Recipient profile files are `apps/client/wrangler.staging.native-portal-acceptance.json`
  and `apps/operations/wrangler.staging.native-portal-acceptance.json`.
- These are validated local candidates, not live activation evidence. Before
  deployment, pin the accepted release revision, check actual deployed
  configuration/bindings and migration readback, and retain the exact rollback
  versions. GitHub publication and exact-head remote CI remain separate gates.
- Open the workspace window Client then Ops; close it Ops then Client. Open the
  recipient service-home window Ops then Client; close it Client then Ops. Do
  not hand-combine the independently validated activation windows.
- The synthetic onboarding permission rehearsal left no active grants. Actual
  onboarding acceptance still needs its own reviewed bounded provision/revoke.

## Live pre-window inventory — 2026-10-02

- Read-only deployment inventory confirms Operations version
  `363c9714-bd6f-4eeb-96df-fef681f4a44a` and Client version
  `2512de43-cd37-4118-97d9-d0c241a3fabd`, each at 100 percent traffic.
  These are rollback reference points, not acceptance of the new candidate.
- The generated Operations base differs from the deployed version in five
  PA acceptance/transport flags, onboarding enablement/origin, and notification
  sender/triage settings. The Client invitation sender also differs. Preserving
  the existing PA/onboarding flags fails the default-off base preflight, so
  these differences need an explicit reviewed window plan, not blind copying
  or bypassing the validator.
- The generated workspace configuration also lacks the exact owner-page
  Worker-first route. Fix the canonical staging inventory and add regression
  coverage before rebuilding or uploading a candidate. The existing server
  gates must receive that request even when the feature is disabled.
- No version upload, deployment, gate change, or new grant occurred during
  these inventory checks. Re-read current versions before a later deployment.
- Remote migration-list checks report no pending Operations or Client staging
  migrations. This is a ledger check, not proof of live authorization or content.
- Secret-name inventory confirms both
  `CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_CSRF_SECRET` and
  `CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET` are absent from
  Client staging. Provision fresh staging-only secrets through the reviewed
  secret workflow before enrollment/content acceptance, without printing their
  values. The name check does not validate secret contents or runtime health.

## Subsequent staging preparation — 2026-10-02

- Published candidate `af31f14c6b56300167a50e8a12838fa1a4ae4b85` includes the
  canonical owner-page Worker-first route correction (`625731d4`). Applied only
  that route correction to the ignored Ops base and both acceptance configs.
  Full staging preflight, portal pair validation and workspace pair validation
  now pass on disk. Their earlier dry-run evidence does not cover this correction;
  fresh upload/dry-run gates remain. Focused route/profile tests passed 41/41.
- Bootstrap test pins now match all 165 canonical Ops migrations. Its isolated
  run passed 19 tests with four Windows symlink-permission skips and no failures.
- Exact candidate CI run `37052911043` is in progress. The preceding run
  `37051093191` is terminal cancelled: nine jobs succeeded, while the Operations
  job was cancelled. Neither result proves the new candidate's complete CI.
- Prepared only the two missing Client native enrollment/audit secrets using
  cryptographic random values through in-memory stdin to `versions secret bulk`.
  Undeployed version `03934748-73a5-47a3-b280-245afd39e46b` contains both names as
  `secret_text`. No values were printed, written to source, or published.
- Re-read deployed traffic after preparation: Client remains at version
  `2512de43-cd37-4118-97d9-d0c241a3fabd`, 100 percent, deployment
  `ceea1cfc-f581-4a20-b29f-598df0f708bd`. No enrollment or grant was activated.
- Wrangler 4.118.0's latest-version secret listing failed while reading bindings;
  exact-version JSON inspection verified the secret names instead. Comparison
  found all existing bindings unchanged, but the API serialized an explicit
  asset `html_handling=auto-trailing-slash` where the deployed version omitted
  that field, plus deployment provenance metadata. Do not claim byte-identical
  resources or blindly promote this secret-preparation version. Validate the
  final reviewed code/config candidate and exact rollback before traffic changes.

## Refreshed staging drain checks — 2026-10-02

- Preserved exact deployed notification/invitation senders and the Operations
  triage recipient in both ignored bases and their paired profiles. All three
  validators pass after these edits. Fresh Wrangler dry-runs passed for both
  Workers in both windows (four bundles); no version upload or deployment.
- Read-only staging PA counts show zero pending/leased directory, relationship
  and project outboxes; zero directory write fences and active project command
  reservations; zero unresolved acquisition/revision-refresh latest events.
- One historical Project-v2 event remains `uncertain` at version 2, while its
  outbox is `terminal`, has no lease, and has no success receipt. The dispatcher
  explicitly treats uncertainty as terminal and does not retry terminal rows.
  Preserve this evidence unchanged. It is not running work and does not prove
  successful Project-v2 write acceptance.
- Read-only portal counts show zero in-flight legacy/native authority,
  delivery, workspace/publication and cleanup outboxes; zero active recipient,
  delivery, workspace/folder reservation or publication heads; zero unresolved
  native recipient intents, cleanup invocations and onboarding decision fences.
- Two onboarding invitations remain `pending`: one is expired, one remains
  valid until October 9. There are no undecided submissions or active onboarding
  identity bindings. Do not delete or silently revoke those invitations to
  manufacture a clean baseline. Verify their fixture provenance and either
  finish the intended onboarding acceptance or document a bounded temporary
  window closure with exact restoration before new portal deployment.
- The direct query readback returned zero rows written. Wrangler file mode
  returned execution metadata rather than SELECT results; the aggregate results
  were independently obtained through its command query path. No raw invitation
  secrets, handoff payloads, credentials or private client fields were read.

## Historical joined-fixture recheck — 2026-10-02

- The long-lived full Operations run started at 12:02, before the historical
  authority-producer pin correction committed at 12:59 as `17b532b9`. It later
  reported four failures in the canonical joined recipient/delivery suite.
- An independent isolated rerun of that exact suite against clean current
  commit `5a524c48` passed all four tests, exit 0, in 175.09 seconds. No source
  or authorization guard changes were required.
- The current-revision result supports the corrected historical fixture; it
  does not turn the earlier mixed-time full run into current-head acceptance,
  nor establish live PA sync, recipient sign-in or file-access readiness.
- Preserve the original full run and its diagnostic result independently;
  do not restart it solely because it is quiet or overwrite its failure evidence.

Local evidence on 2026-10-02: 14 owner-handler tests passed, including exact
folder reserve/revoke, domain-denial short circuit and replay; Operations
typecheck/build passed, and 35 paired-workspace-profile/scaffold/preflight tests
passed. No live workspace or recipient grant was created by these checks.
