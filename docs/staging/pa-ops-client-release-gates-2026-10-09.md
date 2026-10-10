# PA–Ops and client portal release gates

Last authoritative checks: 2026-10-10 02:29 UTC. This is a staging checkpoint, not production readiness.

## Current candidate

- Review branch: `codex/staging-portal-acceptance-tooling`, PR 146.
- Source/test-tooling revision: `abbdb2824408924f90e6971eadbadef25db744ef`.
- Exact-revision CI: run `38016348061` finished with nine jobs passed and Operations failed. Operations reported 398 passing files, one failing file, 3,852 passing tests and three failures in `verified-recipient-delivery-authority-canonical-joined.test.ts` (lines 143, 193 and 280: expected activated, received blocked). Diagnosis is required; this is not a green release candidate. Do not use an earlier green revision as this candidate's CI evidence.
- Deployed Ops staging runtime: `dbe5d1b6-05bd-4aa2-b5bb-273493be57da`, built from runtime revision `bb694bb142e98dca955ef68f3660c2f6d08d42fb`. The successor only changes tooling, tests and documentation.
- Client staging: `811843ea-2a25-447d-9b35-70e541f02583`.
- Ops staging migration chain: 183; migration 0183 and independent schema/history preservation readback passed. No production migration was applied.

## Completed evidence

- Native standalone Client Hub and notes render in the authenticated in-app staging session.
- Native create/ACK/acquisition, unequal Ops/PA ID, notes, race and trigger regressions: 59 tests passed.
- Current-contract governed authority: 96 tests passed; organization/Project compilers: 20 passed; organization window/full-schema: 10 passed.
- Current full-chain Operations regressions: 10 files, 66 tests passed.
- Exact selected synthetic organization has its current record, enrollment and PA mapping.
- Audited temporary permissions on that organization made it an eligible choice in the normal form. They were subsequently revoked because the owner was unavailable. This proved eligibility, not a customer relationship write or portal grant.

## Critical path, in order

1. Submit the prepared synthetic client's organization assignment once through the normal authenticated UI. Current readback: relationship version 1, no parent, no relationship outbox command. Reconcile any uncertain response before retrying.
2. Prove the resulting version-2 relationship and exact PA acknowledgment; a pending command alone is insufficient.
3. Complete PA-first Project discovery, review, reservation, binding and finalization. Verify one-to-one mapping and explicit conflict/idempotency behavior.
4. Complete verified recipient enrollment and explicit owner confirmation; establish service-home access without implicitly granting files.
5. Grant only the selected synthetic folder, sign in as the recipient, verify actual download bytes and deny excluded-folder/cross-principal access.
6. Revoke and prove access denial. Reconcile and close temporary test authority using the exact saved artifacts.
7. Complete scheduler, ten-minute outage/recovery, rollback and exact-revision CI gates.
8. Only after those gates pass, provide the owner exact production PA revisions, migrations/configuration and safe validation order. The owner updates both production PA instances before production acceptance.

## Temporary-window cleanup

- Organization authority provision artifact: `.backups/staging-native-authority/1061fa44-cfae-4d71-a346-d05f5681a6bd/provision.json` (private, not tracked).
- Paired close succeeded using that exact artifact. Private close evidence: `.backups/staging-native-authority/77c23e66-66d0-4089-8d31-3c40af7e69ae/revoke-recovery-2026-10-10T02-29-22.682Z.json`. Independent readback at 02:29:38 UTC found zero applicable active allows, relationship version 1 with no parent and no relationship outbox rows. No temporary permission remains active.
- Cleanup uses `staging-organization-relationship-authority-window.mjs close` with that exact artifact and the existing pinned staging configuration. On uncertain apply/close, use `reconcile`; never issue a fresh packet as a retry shortcut.
- Immediate Ops staging Worker rollback target: `8bf8b9e0-76d7-430b-9952-649e56d90b45`. A Worker rollback does not require database restoration.

## Boundaries

- Production PA, production portal access/cutover and existing public links are unchanged.
- Do not replace normal staff authentication with account/service-token authority or export session cookies.
- No reliable client go-live estimate until the live acceptance gates above pass. Local tests and prepared object bytes do not prove recipient login/data access.
- Branch cleanup cannot delete unique commits, main/dev, active PR dependencies or worktree-attached branches simply to reduce the branch count.

## PA release lineage still to prove

- PA staging candidate `3c99c78accc73c5741832ead2c1b60508e4c350b` is not contained in current remote main `1513b6a860a045e1a22e916e282699dea5ce2469`.
- Catalog PR 190 currently ends at `4de49e8f59a6ad24c60502e8f1a43355b1b31146`; the staging candidate adds `5bed11a7` (Directory create conflict identification) and `3c99c78a` (scoped Project adoption discovery). These commits need their own verified publication/CI/review path before any production update instruction. Do not assume merging PR 190 alone reproduces the tested staging image.
- Read-only release review found conflicts between the current candidate and managed-directory PR 188 in the Directory-create implementation and its tests. PR 190's green checks therefore do not prove combined managed-directory/catalog/adoption behavior. A separate local `codex/api-v2-managed-catalog-staging` worktree was created from PR 188's exact head `731677dda1821c53f93dd0b38f1504f184c320d9` to integrate and test the candidate before any main merge. No combined candidate is deployed or production-ready yet.
- The existing uncombined candidate's four focused API test classes passed **35 tests, 535 assertions** on PHP 8.2.12. This is unit/SQLite evidence, not MySQL or combined-source acceptance. Managed-directory authority, conflict codes, Project discovery, default-off behavior and link neutrality need fresh combined-source verification.
- PR 189's workforce changes are not this release's critical path. PR 150 is draft/stale relative to main and must not be promoted merely on historical checks; prove whether its adapter is required by the current native portal contract before including it.

## Combined PA candidate evidence

- The isolated merge of managed-directory PR 188 (`731677dda1821c53f93dd0b38f1504f184c320d9`) and the complete staging candidate (`3c99c78accc73c5741832ead2c1b60508e4c350b`) was reviewed, committed and published as `6c88a1cd0cfce25a2d25d264ff9e7fe0d0349bcd` on `codex/api-v2-managed-catalog-staging`, draft [PA PR 195](https://github.com/ledgetoptechnologies/Project-Alpha/pull/195). Both original heads remain intact; no combined deployment or main merge has occurred.
- Resolution preserves managed-directory lock ordering and prior-epoch checks. Only a valid stale authorization generation yields `authorization_generation_conflict`; missing, malformed or exhausted generation state remains a generic conflict.
- All 15 staged PHP files lint successfully. Combined catalog, Directory create, Project synchronization, read-route defaults and external-directory policy suites passed **55 tests, 734 assertions** with result-cache writes disabled.
- A new managed-mode regression verifies the structured stale-generation response produces no client or command receipt and leaves a public-link sentinel unchanged. This is local evidence, not a claim that live public links or full MySQL behavior were exercised.
- The combined-source isolated MySQL Directory-create suite passed **4 tests, 41 assertions**, including stale-generation/replay, atomic receipt rollback and lock-contention checks. The separate managed-directory cutover suite passed **4 tests, 95 assertions**, covering writer/activation/takeover ordering. Both runners used new disposable localhost-only MySQL containers; independent Docker inventory confirmed cleanup. Full remote CI and staging end-to-end acceptance remain required.
- All five exact-revision checks passed for PA `6c88a1cd`: full CI `38017966876`, Gitleaks `38017966871`, CodeQL `38017966861` and its aggregate result. Full CI exercised the Compose web/cron path, PHPUnit, frontend and existing isolated MySQL suites. The app refused to attach the PR because this chat exceeds its 100-attachment limit; the PR URL and exact revision are recorded here without removing any existing attachment.
- Additional combined-source compatibility checks passed: existing portal service/contact/delivery projection suites **54 tests, 649 assertions**, plus **30 frontend tests**. The new isolated MySQL read suite passed **4 tests, 36 assertions**, covering stable/stale catalog pages, actual raw-byte rejection and concurrent binding visibility. Its reviewed generic runner and mandatory CI step were committed/published as successor `33486e0c7306b1d7e314020b93e3ffff3af3837b` on PR 195; no runtime changes were included in that successor. Fresh successor checks must pass before promotion; predecessor green checks do not prove its new CI image path.

## Adapter and financial contract separation

- Read-only source review found PR 150 implements an optional operator-queued managed-delivery adapter (`delivery-intents/preflight`, `delivery-intents`, and `delivery-intents/revoke`). It does not implement generic API-v2 financial reads, native recipient login, enrollment or folder authorization. It is not a prerequisite for proving native login and selected-folder access.
- The requested financial dashboard remains an explicit unfinished requirement, not something this adapter resolves. It needs scoped, client-filtered finance summaries, document metadata/balances, contract lifecycle, receipt/activity state and current permitted action-link reads, with stable source/customer/project identities and freshness.
- Financial reads must never create or revive missing, expired or revoked public links. PA remains financial authority. Do not present unavailable financial sections as working, or treat native folder-access acceptance as completion of the full financial portal contract.
- Sources: PA PR 150 `docs/managed-delivery.md`, `ManagedDeliveryService.php`, `ManagedDeliveryIntentSender.php`; Ops `docs/operations/operations-api-first-system-audit-2026-09-09.md` financial-read and link-neutrality requirements.
