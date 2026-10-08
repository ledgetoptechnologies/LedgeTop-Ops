# Live staging acceptance sequence

This is a source-reviewed execution map, not evidence of successful live acceptance. Keep production PA, client activation and existing public links unchanged. Use only explicitly selected synthetic staging records and backing data.

## Directory and projects

- Start with the existing synthetic pending customer; do not create a replacement to avoid its cleanup obligations. Require normal outbox acknowledgment, exact destination readback and no duplicate PA customer.
- Open `/clients` in Operations staging. Open the exact customer and use **Edit client profile → Save client profile**. Require both local revision and PA acknowledgment/readback. Ordinary repeated clicks generate different mutations; they do not prove idempotent replay.
- The browser editor does not expose same-mutation replay or same-key/different-body conflict tests. Run these through a supported authenticated acceptance transport, or implement a reviewed transport before claiming these cases passed. Do not export browser credentials or inject network calls through read-only browser evaluation.
- A fixed acceptance page is implemented at `/administration/staging/directory-replay-acceptance`, restricted to the retained synthetic record. Its published artifact is still inactive. The local successor adds independent configured PA profile GET verification before fresh-key restore and after restoration; it must pass tests/review and its own release gate before use. Local profile reload is not independent PA evidence. Retain the exact temporary grants until replay, conflict, PA readback, and restore have all finished.
- Current Operations project creation links to Project Alpha. Create the explicitly selected synthetic project there, then perform bounded API sync and verify its one-to-one customer/project mapping in Operations. Do not claim that Operations already has a native project-create form.
- Canonical customer workspace: `/clients/sources/{sourceId}/business/{organizations|standalone}/{publicId}`. Project detail appends `/projects/{pa|canonical}/{projectId}`. Never infer links from names or addresses.

## Workspace and selected folder

- Owner page: `/administration/client-portal/operations-workspaces` on Operations staging only.
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

**Current status:** the trial described below is stopped. Operations staging version `cf924df0-7089-4529-96c2-9dc7d685c949` is active at 100% after CI run `37826422942` passed all ten jobs for `9ce00e85191ab1db570d317f06b6fafb83cee9c8`. All 140 bindings and script runtime matched predecessor `1516f6aa-0e98-4d9c-871a-9078052d6043`, retained as rollback. The live read-only diagnostic passed reads but reported both client-write prerequisites missing their granted capability. Specific key-scope approval remains pending. Draining remains disabled and the cron registry empty. The historical tail handle below is not live. Settlement of the existing command and paired authority-window cleanup are still required; do not open a replacement window.

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
