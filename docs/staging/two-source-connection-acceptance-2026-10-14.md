# PA Ops two source connection acceptance

The connection goal remains active. Local two-source checks and a private-primary portal correction are ready for review; live Stage Two API provisioning, paired write acceptance, and portal sign-in acceptance remain release gates. Production PA updates remain an owner checkpoint after staging acceptance.

## Candidate changes

The versioned `scripts/staging-ops-two-source-connection-profile-v1.mjs` validates operator-supplied public metadata and builds the credential envelope separately in memory. The template deliberately contains null identities. Run `npm run staging:two-source:check -- --values <operator-metadata.json>` after supplying verified identities. Keep actual keys in a private secret channel; the checker never deploys or writes configuration.

Stage One retains `project-alpha:staging` and `https://pa-staging.ledgetoptechnologies.com`. Stage Two uses `https://pa-stage-two.ledgetoptechnologies.com`. Independent installations require distinct source-instance identities; PA-local application/history identifiers can coincide across installations. A malformed or disabled sibling blocks profile preparation. Initial read declarations contain `api.capabilities.read`, `directory.inventory.read`, and `projects.inventory.read`; validate actual grants and inventory flags against PA before claiming read acceptance. Local declarations do not restrict a key's actual remote scopes.

The joined Client test exposed a private-primary readiness defect: private ingress accepted projections while native reads required fingerprints registered by the former direct HTTP receiver and a copied PA HMAC secret. The correction adds migration `0231_portal_primary_private_ingress_authority.sql` and an explicit private-primary authority proof. Validated private ingress reserves the immutable application identity; browser reads cannot reserve it. Suspension, retirement, application drift, and stale proof versions deny access and writes. Secondary authority and historical direct-signature paths retain their existing guards.

Migration 0231 starts empty. It grants no memberships or financial authority and changes no existing public-share rows. In explicit private mode (`PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED=false`), native primary reads require its current authority record and exact configured `PROJECT_ALPHA_PORTAL_APPLICATION_KEY`; they never fall back to historical HMAC proof. A valid private projection enrolls the first record. Replay cannot reactivate suspended or retired authority.

## Current live staging evidence

Read-only checks on October 14, 2026 confirmed HTTP 200 native-login pages at both canonical staging PA origins and the Stage One compatibility origin, without an Access challenge or first-admin setup form. Signed-in Ops staging read verification returned Directory 15 and Projects 5. Only `project-alpha:staging` was listed in the enabled API-v2 source selector.

Provider inspection found Ops version `550120ea-da26-46ac-9027-b5574275695b` at 100 percent, deployment `d7afd38d-b393-42d2-979c-ee70f3fa32de`, and Client version `2dca4413-fe10-4112-94d4-ca4b5c5d31ef` at 100 percent, deployment `4cffdabc-de46-4367-b8e8-2f9de78ff40d`. Ops profile writes and binding continuation are enabled; outbox drain remains false. These deployed versions differ from earlier handoff observations. The new local changes have not been deployed.

Wrangler's remote ledger reads failed with a network fetch error; the Cloudflare connector then verified Ops has 203 migrations through `0203_effective_native_directory_enrollment_consumers.sql` and Client has 149 through `0230_operations_portal_native_delivery_terminal_cancellations.sql`. Migration 0231 is pending. Recheck actual pending migrations before applying anything. PR 161 remains open and draft at `1a22c0c7541235f2855a645f0336309d39997299`, with all ten recorded CI jobs passing. Those checks predate this candidate.

## Local candidate validation

- Operations connection/configuration, reviewed-import HTTP and Viewer issuance: 94 tests passed across five files.
- Client private ingress, primary authority and existing portal projection: 33 tests passed across three files. Joined primary/secondary native authorization: seven tests passed.
- Reviewed-import enrollment browser suite: seven desktop Edge and seven mobile Edge tests passed.
- Repository layout and two-source profile: 36 tests passed. Bootstrap/native migration profiles: 36 passed, with five Windows symlink-policy skips. Frozen paired migration planner: 24 passed. Staging evidence: 58 passed.
- Client structural rehearsal: three tests passed, covering historical 149-entry bootstrap idempotency, fresh 150-entry candidate with empty private authority, and preservation across 18 pending candidate migrations after the captured historical ledger.
- Client and Operations typechecks and application builds passed. Independent source, privacy and compatibility review found no unresolved actionable issue after corrections.

These checks are local/synthetic. Current-commit CI and live paired staging acceptance remain outstanding.

## Staging rollout gates

1. Obtain Hermes's current Stage Two application/key status, non-secret source/application/history identities, inventory flags, scopes, and private key location. Reuse the officially bound application; do not create a duplicate blindly. Never record a key value in this note or chat.
2. Reconcile current staging configuration, migration ledger, existing source pins, and backup/rollback artifacts. Keep the legacy Stage One origin and public links. Review all existing pending Client migrations before additive 0231; this note authorizes no claim that its prerequisites are already applied.
3. Run the candidate's current-commit CI, structural upgrade rehearsal, and focused tests. For Client private-primary consumers, configure the exact application pin and explicit private mode. Operations Viewer issuance and authenticated-delivery bell consumers of Client's authority database need the same mode and application pin; the Operations environment type now supports the mode. Verify these companion values before their acceptance; no production setting is enabled by this change.
4. Apply the reviewed staging migration/configuration order, then configure both actual keys through the secret channel. Probe both exact identities, inspect bounded inventory/conflicts, and verify malformed/disabled siblings fail closed.
5. Run bounded synthetic client/organization/project create, edit, explicit import, lifecycle/archive, settlement, replay/idempotency, denied-scope, drift and recovery checks in both PA sources. Local mocked transports do not satisfy this gate.
6. Test primary-plus-secondary client sign-in and access with colliding external IDs, distinct principals, selected data reads, financial authority, same-session revocation, and actual existing public URLs. The local joined test verifies Client private ingress and native authorization; it does not exercise live Ops Sync producer authentication/forwarding, a browser login, financial document bytes, or public URL reachability.
7. Prepare exact revisions, migration/configuration order, backups and rollback. Only after staging sync and portal gates pass, ask the owner to update both production PA instances, then validate production login/data access in the agreed safe order. Do not update PA production, enable production client access, or cut over the portal before that checkpoint.

The pre-existing stage-host transition note and all historical migrations are preserved. No production PA update, client activation, portal cutover, or public-link rewrite was performed.
