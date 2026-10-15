# Live staging acceptance sequence

This is a source-reviewed execution map, not evidence of successful live acceptance. Keep production PA, client activation and existing public links unchanged. Use only explicitly selected synthetic staging records and backing data.

## Current release gate

- CI run `37842501657` passed all ten jobs for test/documentation successor `c7fab42a`. Runtime-equivalent source `b63a21b7` is active on Ops staging as version `8b21698d-de6e-400d-bd4e-9990bbaa5834` at 100%; Client remains unchanged. Earlier pending-CI/inactive-artifact statements in this execution map are superseded.
- Normal browser verification now passes Directory 14 / Projects 2 and advertises both client-create and profile-write capabilities after the approved key scopes and two PA server flags were enabled. PA web is healthy on the unchanged candidate image. This is prerequisite verification, not successful write synchronization. Project activation and Directory draining remain off, with zero cron triggers. No live recipient or file-byte acceptance is claimed.

### Latest execution evidence

- Project create/update acceptance now passed through the normal authenticated staging page: exact retries, changed-body conflicts, and authoritative readback. Independent PA SQL confirmed revisions 1 and 2 on one permanent project; staging D1 confirmed both commands acknowledged. The temporary scoped Project grant is revoked (inactive/version 2, generation 14), and deployment `ee4d470e-6000-43a7-90e1-ed9b216474aa` restored baseline `8b21698d-de6e-400d-bd4e-9990bbaa5834` at 100%, activation/draining false and zero crons. See the latest section of `portal-acceptance-checkpoint-2026-10-08.md` for exact receipts and projection hash. This does not cover the PA-first half or recipient/file access.

- The preview scheduler has now actually run once: attempted 1, conflicted 1, acknowledged 0. The retained creation command is terminal with HTTP 409 and no lease, not pending. Independent PA readback proves stale expected generation 52 versus current 53 and no same-command receipt/external binding. Follow supported fresh-state recovery for this same record; do not edit the old command or create a replacement customer.
- Paired Directory grant recovery completed with `cleanupVerified:true`; independent readback shows zero active grants in the exact synthetic area. The temporary preview routing is reverted and all test-only Access policies/tokens are removed. Earlier pending/active-grant statements below are historical. Re-establish authority only through a reviewed paired workflow when the supported recovery is ready.

- The complete boolean-only prelease diagnostic was inspected before execution. Both SELECTs passed every required command/actor/destination/grant/scope/deny check, with zero rows written. The retained command remains pending with zero attempts. The stored standalone-client transport validator also passed.
- A supported remote-preview scheduler test stopped before invocation because Cloudflare Access requires service-token credentials in this non-interactive runner. The account API token is not an Access service token. No Access bypass, policy change, forced settlement, or replacement command was attempted; the preview process exited.
- PA staging was recreated with only the authorized client-create/write flags added, retaining image `ltt-pa-stage-candidate:4de49e8` and the existing catalog flag through a stdin Compose overlay. The base Compose file was not edited; a later base-only recreation will not retain these overlay flags. Preserve/reapply the overlay in the staging operator workflow. No production setting changed.

## Directory and projects

- Start with the existing synthetic pending customer; do not create a replacement to avoid its cleanup obligations. Require normal outbox acknowledgment, exact destination readback and no duplicate PA customer.
- Open `/clients` in Operations staging. Open the exact customer and use **Edit client profile → Save client profile**. Require both local revision and PA acknowledgment/readback. Ordinary repeated clicks generate different mutations; they do not prove idempotent replay.
- The normal browser editor does not expose same-mutation replay or same-key/different-body conflict tests. Use the first-party acceptance page below after its release gate passes. Do not export browser credentials or inject network calls through read-only browser evaluation.
- The deployed first-party acceptance page at `/administration/staging/directory-replay-acceptance` is restricted to the retained synthetic record, with independent configured PA profile GET verification before fresh-key restore and after restoration. Its CI/release gate has passed, but live staging execution remains required before any write outcome can be claimed. Local profile reload is not independent PA evidence. Retain the exact temporary grants until replay, conflict, PA readback, and restore have all finished.
- For the PA-first half of dual-editor acceptance, create the explicitly selected synthetic project in PA, then perform bounded API sync and verify its one-to-one customer/project mapping in Operations. The ordinary Operations project-create action still links to PA; the staging-only acceptance page below is not a general client-facing project-create form.
- The deployed first-party exact-host Project acceptance page at `/administration/staging/project-v2-replay-acceptance` and authenticated preparation endpoint obtain server-derived current-state fences and use the normal CSRF-protected transport for create, update, exact replay, deliberate changed-body conflict, and readback. This live sequence has passed for the explicitly mapped synthetic organization. Its temporary activation and authority window is closed. Do not rerun create with a replacement ID or pass the retained standalone client as a substitute. The PA-first dual-editor half remains separate; do not export session credentials to the legacy harness.
- Canonical customer workspace: `/clients/sources/{sourceId}/business/{organizations|standalone}/{publicId}`. Project detail appends `/projects/{pa|canonical}/{projectId}`. Never infer links from names or addresses.

## Workspace and selected folder

- Owner page: `/administration/client-portal/operations-workspaces` on Operations staging only.
- Keep workspace ownership aligned with the fixture: the retained standalone client belongs only to Directory replay, while Project acceptance uses the explicitly mapped organization and an organization-root portal workspace. Do not attach the organization-owned project to a standalone-client workspace. Generate and explicitly review fresh workspace IDs through the normal workflow after the relevant PA settlement/restoration; do not guess or reuse a tuple. Portal flags being enabled does not create a fixture or grant access.
- Create and publish the exact workspace using its target UUID, client-authority UUID, Client workspace ID, exact root kind/record/version, standalone relationship version where required, and reason. Require acknowledged publication; publication alone gives nobody access.
- Load and confirm the exact native project folder. Review its destination division and base R2 prefix. Reserve/publish only the selected synthetic folder with exact expected workspace, folder and publication revisions. Obtain evidence from acknowledged records, not guessed identifiers.

## Actual recipient and file access

- Owner page: `/administration/client-portal/operations-recipients`. Issue confirmation for the exact existing target and customer with bounded expiry and explicit target acknowledgment. Keep the reveal-once link private.
- Recipient opens the issued Client enrollment link, signs in, reviews and submits consent. Owner loads the exact intent, reviews its target/customer/binding and server-verified Access identity, then confirms it. Require acknowledged active enrollment. Service-home access alone grants no folder access.
- Owner page: `/administration/client-portal/operations-delivery-authority`. Load current candidates, select the exact recipient/folder pair, review revisions, features, expiry and reason, then grant. Require acknowledged settlement. Retry only the same frozen operation after uncertainty; reload/review stale conflicts.
- Recipient opens Client `/portal`, then **Shared deliveries → Browse shared deliveries**. Verify the intended folder, nested item and permitted preview/download against real synthetic backing data. Verify sibling/cross-customer data is absent or denied.

## Revocation and cleanup

- Revoke the exact delivery authority first and require acknowledgment. Refresh/refocus the recipient portal and prove the folder is gone or denied, not merely hidden by owner UI state.
- Revoke the exact native recipient and require acknowledgment. Verify service-home denial from the actual recipient session.
- Revoke/publish the selected folder using its current revisions. Workspace cleanup does not enumerate or revoke recipients automatically.
- Stop the bounded Directory drain, restore the original empty cron registry, then close the existing audited temporary authority window using its saved paired recovery artifact. Require cleanup receipt/readback and zero active grants in its exact synthetic area.

## Historical pre-promotion window — superseded by the current release gate above

- Fresh read-only candidate preflight after publishing `c7fab42a` confirmed inactive version `8b21698d-de6e-400d-bd4e-9990bbaa5834` retains all **140 binding objects** and the complete runtime object from active `cf924df0-7089-4529-96c2-9dc7d685c949`. Active traffic remains 100% on that predecessor; the cron registry is empty, and both candidate Directory draining and Project activation remain false. The successor changes only tests/docs relative to the candidate's `b63a21b7` source. These are configuration/provenance checks, not CI success or permission to start live writes. Recheck before any later promotion.
- The retained synthetic Directory command still reads `pending`, attempts **0**, no lease; its exact synthetic area still has **three active grants**. Both diagnostic SELECTs reported zero rows written and unchanged database state. The cleanup obligation remains; do not replace the command or claim automatic grant expiration.

**Status at that earlier checkpoint:** the trial below was stopped, CI `37842501657` was still live, and traffic was on `cf924df0-7089-4529-96c2-9dc7d685c949`. CI has since passed and the successor runtime has been promoted as recorded above. The remaining obligations are unchanged: approved write scopes, live Directory/Project/portal acceptance, legitimate settlement of the retained command, and paired authority cleanup. Draining remains disabled and the cron registry empty. The historical tail handle below is not live; do not open a replacement authority window to avoid the retained work.

- At approximately 17:34 UTC, promoted staging-only drain version `223333fb-28ee-4ea2-a94e-dfe1fc0dbe7e` and installed only `1-56/5 * * * *`. The pinned restore version is `ac6bdf2c-e6ea-4d7d-bec8-16af555ff6a6`; original cron registry is empty.
- All database-backed command/evidence/actor/selected-grant/scope/deny diagnostics passed for the existing synthetic command. No diagnostic query wrote data. This does not prove runtime destination pins, scheduler invocation or remote settlement.
- During that historical trial, filtered tail session `58098` was the observation handle; it is now stopped. Cron propagation is asynchronous; do not restart a future trial merely because a short observation returns no events. Recheck authoritative command state and scheduler evidence after propagation, and restore the staging controls after a bounded trial even if settlement fails.

### Trial stopped for a verified prerequisite

- Subsequent PA staging UI inspection found key #5 lacks client creation/profile-write scopes. Requested specific action-time approval for those two scopes; no key settings were changed. This does not identify why no lease attempt was recorded.
- Restored drain-disabled version `ac6bdf2c-e6ea-4d7d-bec8-16af555ff6a6` at 100% and the original empty cron registry. Tail `58098` is stopped, not a live wait handle. Verify PA write flags and approved scopes before another trial.

### Exact PA client-write prerequisites

- Source inspection at the PA staging UI revision `4de49e8f59a6ad24c60502e8f1a43355b1b31146` identifies `APP_API_V2_DIRECTORY_CLIENTS_CREATE_ENABLED=true` and `APP_API_V2_DIRECTORY_CLIENTS_WRITE_ENABLED=true` as the two client-command feature gates. They are default-off; source inspection is not running-container readback.
- Key #5 separately needs explicit `directory.clients.create` and `directory.clients.write`, alongside its existing `api.capabilities.read`. The current standalone synthetic creation does not need organization assignment, organization mutation, financial or lifecycle scopes. Both client mutation scopes were still unchecked on fresh browser inspection; no settings were changed.
- Verify running capabilities and the exact bound source/application/history identities after authorized configuration, before restarting bounded draining. A successful read-only verification does not prove these mutation prerequisites.
