# Live staging acceptance sequence

This is a source-reviewed execution map, not evidence of successful live acceptance. Keep production PA, client activation and existing public links unchanged. Use only explicitly selected synthetic staging records and backing data.

## Directory and projects

- Start with the existing synthetic pending customer; do not create a replacement to avoid its cleanup obligations. Require normal outbox acknowledgment, exact destination readback and no duplicate PA customer.
- Open `/clients` in Operations staging. Open the exact customer and use **Edit client profile → Save client profile**. Require both local revision and PA acknowledgment/readback. Ordinary repeated clicks generate different mutations; they do not prove idempotent replay.
- The normal browser editor does not expose same-mutation replay or same-key/different-body conflict tests. Use the first-party acceptance page below after its release gate passes. Do not export browser credentials or inject network calls through read-only browser evaluation.
- Current source includes the first-party acceptance page at `/administration/staging/directory-replay-acceptance`, restricted to the retained synthetic record, with independent configured PA profile GET verification before fresh-key restore and after restoration. Its current exact revision still needs a successful CI/release gate and live staging execution before any outcome can be claimed. Local profile reload is not independent PA evidence. Retain the exact temporary grants until replay, conflict, PA readback, and restore have all finished.
- For the PA-first half of dual-editor acceptance, create the explicitly selected synthetic project in PA, then perform bounded API sync and verify its one-to-one customer/project mapping in Operations. The ordinary Operations project-create action still links to PA; the staging-only acceptance page below is not a general client-facing project-create form.
- Current source now includes a first-party exact-host Project acceptance page at `/administration/staging/project-v2-replay-acceptance` and an authenticated preparation endpoint. They obtain server-derived current-state fences and use the normal CSRF-protected transport for create, update, exact replay, deliberate changed-body conflict, and readback. This closes the former local transport/UI gap only; the current revision still needs a successful CI/release gate and the full sequence still needs live staging evidence. The joined create contract requires the explicitly mapped organization; do not pass the retained standalone client as a substitute or export session credentials to the legacy harness.
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

## Current execution window

- Fresh read-only candidate preflight after publishing `c7fab42a` confirmed inactive version `8b21698d-de6e-400d-bd4e-9990bbaa5834` retains all **140 binding objects** and the complete runtime object from active `cf924df0-7089-4529-96c2-9dc7d685c949`. Active traffic remains 100% on that predecessor; the cron registry is empty, and both candidate Directory draining and Project activation remain false. The successor changes only tests/docs relative to the candidate's `b63a21b7` source. These are configuration/provenance checks, not CI success or permission to start live writes. Recheck before any later promotion.
- The retained synthetic Directory command still reads `pending`, attempts **0**, no lease; its exact synthetic area still has **three active grants**. Both diagnostic SELECTs reported zero rows written and unchanged database state. The cleanup obligation remains; do not replace the command or claim automatic grant expiration.

**Current status:** the trial described below is stopped. Current source head `c7fab42ae559c40d7e6d4de96f6eede2073a4f88` contains the first-party Directory replay flow and Project preparation/replay UI described above. Exact-head CI run `37842501657` has only been confirmed live; it is **not** a passing release gate. Do not promote or claim live Directory, Project, portal, or production acceptance unless that run reaches terminal success and the remaining deployment/preflight/live checks pass. The last documented active Operations staging version remains `cf924df0-7089-4529-96c2-9dc7d685c949` at 100%; the current source head is not thereby proven active. The live read-only diagnostic passed reads but reported the client-write prerequisites unavailable, and the latest prerequisite audit also found Project create/write scopes unchecked. Specific key-scope approval remains pending. Draining remains disabled and the cron registry empty. The historical tail handle below is not live. Settlement of the existing Directory command and paired authority-window cleanup are still required; do not open a replacement window.

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
