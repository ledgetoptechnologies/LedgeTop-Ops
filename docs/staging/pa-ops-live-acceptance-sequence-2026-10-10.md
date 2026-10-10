# PA–Ops live acceptance sequence

This is the remaining staging acceptance sequence, not a release approval or a claim that clients can already use the new portal. Production PA, production client activation and all existing public links remain outside this window.

## Current gate

- PA staging has the reviewed structured relationship-conflict prerequisite. Ops relationship recovery is still default-off and undeployed.
- Ops staging readback on this continuation has 183 migrations and no pending/leased Directory, relationship or Project commands. The retained failed relationship command is terminal, not recovered.
- Local recovery and bounded-authority tests have passed. Full exact-revision CI, migration 0184, a live recovery acknowledgement and downstream portal acceptance remain required.

### Additional local evidence (not live acceptance)

- The closed recovery-lineage validator passed against actual local D1 trigger state after intact migrations 0001–0184 and the reviewed provision/revoke batches: one full-schema test passed, with no skips. This proves the cleanup evidence format, not a live recovery acknowledgement.
- The focused scalar-settlement, recovery-lineage and release-configuration suite passed 35/35 tests. The current Project authority module is still a prerequisite validator, not a usable provision/revoke workflow.
- The organization scalar fixture uses the actual Directory writer, but currently reproduces dispatcher acknowledgement persistence with local SQL. It does not prove the real dispatcher path or the retained client's acquired-ID/linked-parent path. Those remain required before relying on this fixture for live client acceptance.
- Release configuration preparation is held at the Windows script-policy checkpoint. No generated live configuration values were written and no migration or Worker deployment was performed by these checks.

## 1. Recover the retained synthetic relationship

- Freeze the reviewed source revision and bundle. Preserve all live Worker bindings, runtime resources, schedules and existing flags; add recovery explicitly false. Never deploy the older static config over live variable drift.
- Verify the private pre-0184 backup, exact migration suffix and staging database identity before applying only 0184.
- Use the reviewed v184 authority window only for its exact synthetic client, organization and terminal predecessor. Save private evidence before mutation.
- Enable the bounded staging recovery path, acquire fresh structured conflict proof and canonical reads, explicitly review the sealed comparison, authorize once and dispatch the immutable successor.
- Require its exact acknowledgement. Compare the original terminal command and canonical relationship/history byte-for-byte; recovery must not change them.
- Close the six-grant authority window before ordinary record edits. Confirm paired revocation and no pending/leased work. Do not reuse this packet for later customer or project mutations.

## 2. Prove ordinary customer and project synchronization

- Through the signed-in Ops `/clients` workspace, use the ordinary native Directory profile editor for a scalar-only synthetic customer change. Its supported route is `GET/PATCH /api/client-hub/directory/{organizations|standalone-clients}/:recordId`.
- This requires a fresh, separately reviewed scoped authority window for the current record version. Do not remove/re-add the organization to manufacture a new relationship command.
- Require the normal outbox acknowledgement and matching current PA/Operations readback. Revoke the temporary authority through its paired cleanup.
- Prove PA-first project creation using `/administration#project-alpha-connections`: candidates → review → reserve → bind → finalize. The endpoints are under `/api/admin/project-alpha/private/projects/adoption/`.
- Validate the exact PA candidate and revisions, the required PA read/bind scopes/flags, Ops adoption gates and a fresh deny-aware scoped `project.shared.sync` authority window. Finalization must report `stage=activate` with `outcome.status=activated`.
- Read back the one-to-one mapping and normal bound project inventory. Do not infer a mapping from matching names or treat an unbound PA project as synchronized.

## 3. Prove recipient login and actual selected-file access

- Reserve/publish the synthetic workspace through `/administration/client-portal/operations-workspaces` and verify its exact customer membership.
- Use `/administration/client-portal/operations-recipients` to issue the exact recipient enrollment intent. The recipient follows `/portal/operations-recipient-enrollment/:intentId`; its one-time fragment must be scrubbed. The owner reviews the captured identity and confirms its explicit customer link.
- Verify the signed-in recipient's Client `/portal` service home through `/api/client/v2/operations/home` and the selected authority view. Service-home visibility alone grants no file access.
- Separately grant the exact synthetic folder/features through `/administration/client-portal/operations-delivery-authority`. Require acknowledged workspace/folder/authority publication.
- Use a non-sensitive synthetic R2 object indexed under that exact folder prefix. Client `/portal/deliveries?workspace=<id>` must list the selected folder and file through `/api/client/operations/data/`.
- Fetch actual preview/download bytes through the file-handle routes and compare their hash with the fixture. A successful list, HTTP status alone or metadata-only response is insufficient.
- Prove excluded folders/files and another principal cannot obtain handles or bytes. Confirm drone-only and website-only service visibility separately where fixtures support it.

## 4. Revoke and recover safely

- Revoke the exact delivery authority first. Previously obtained handles and byte requests must fail closed.
- Revoke the recipient enrollment and prove service-home access is absent/denied. Clean up only acceptance-owned workspace state, preserving immutable receipts and project/history records.
- Exercise the agreed ten-minute PA outage notification/recovery behavior and rollback while retaining unrelated Operations functionality and existing public links.
- Only after these gates pass, prepare the exact production PA update checkpoint and safe validation order for the owner. Do not perform that update or production client activation automatically.

## Execution boundaries

- Use real authenticated UI controls or an explicitly supported authenticated test transport. Do not export browser credentials or inject fetch calls through DOM evaluation.
- The joined Directory CLI creates disposable records; it is not a retained-record update harness. Its browser-context library does not currently supply the required supported transport.
- The joined-recipient runner is local orchestration, not live proof of login → listing → bytes → revocation. No checked-in single-command live harness currently covers that entire chain.
- Each later mutation needs the appropriate current scoped authority; recovery cleanup intentionally removes the temporary grants. Do not reopen the fixed recovery packet as a general-purpose administrator shortcut.
- Financial summaries/documents/action links remain a separate implementation and acceptance requirement. Neither service-home metadata nor folder grants establish financial visibility or PA-authoritative payment/signing behavior.
