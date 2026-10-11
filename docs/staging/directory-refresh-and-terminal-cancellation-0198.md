# Staging-only Directory refresh and terminal cancellation successor

## Scope and current state

- Operations migrations 0197 and 0198 are additive successors to the immutable 196-migration chain. Client remains at 149 migrations. Do not rewrite earlier SQL or treat an old release approval as approval of this successor.
- 0197 adds a cancellation-only checkpoint. It tolerates unrelated additions to the eligible project set, while retaining the frozen publication's project identities, versions, folder and Directory evidence. The strict publication/grant checkpoint is unchanged.
- 0198 adds immutable active-binding refresh commands, dispatch state and receipts. It does not repurpose the acquired-only 0118 ledger, change mappings, grant client access, or alter public links.
- The HTTP/UI workflow is absent unless `NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED=true` and the environment is `local` or `staging`. Keep it off in production. A browser capability is not authority; execution rechecks authenticated protected-owner identity, admission, profile, permission scopes and generations, exact mapping, acknowledged write and live PA evidence.
- An uncertain PA response preserves the original command and request bytes for replay, including after page reload. A successful acknowledgement does not manufacture inventory evidence: refresh through the normal authenticated inventory path afterward.

## Local evidence

- Binding refresh: 12 full-schema cases, 24 HTTP/evidence cases, 22 desktop/mobile UI cases, and 82 existing Client Hub/profile UI cases passed. Covers actual historical generation conflicts, forged evidence, authority changes, replay/concurrency, response loss and financial denial until validated inventory persistence.
- Terminal cancellation: focused full-schema case and the existing three cancellation-authority cases passed. The focused case proves strict grant candidates remain unavailable after an unrelated added project, while exact terminal cancellation can settle with a durable receipt and no foreign-key violations.
- Operations type-check and build passed. Exact-candidate CI and live acceptance are separate release gates; local results are not a deployment claim.

## Safe staging validation order

1. Freeze the candidate, confirm its exact CI, and prepare a new reviewed 196-to-198 migration window. Historical 195-to-196 executors must not silently apply new SQL.
2. Capture/verify current staging Worker configuration, named handlers, routes, schedules, container bindings, peer revision, database ledger, all application rows and schema. Back up before applying exactly 0197 and 0198; preserve existing data and permission history.
3. Deploy the exact staging artifact while preserving runtime settings and the Client peer. Initially keep the new binding-refresh flag off; verify default-off routes and health before scoped staging activation.
4. Use the ordinary owner workflow to review and execute the exact synthetic client's stale binding refresh. Verify PA acknowledgement, durable Ops receipt and unchanged mapping identity. Refresh normal inventory and verify current evidence.
5. Reconcile the existing expired file-grant cancellation using its original operation identity. Verify both services' terminal receipts; do not issue a replacement grant first.
6. Run scoped synthetic financial and file-access acceptance, tenant negatives and same-session revocation. Any temporary access must be revoked and independently checked afterward. Do not infer positive acceptance from a correct denial.

## Remaining integration gates

- This owner repair is not automatic ongoing synchronization. Ordinary acknowledged profile updates still need a durable refresh/recovery sequence; do not call sync complete after repairing one fixture.
- Never-dispatched commands whose generation changed remain blocked; no supersession policy is implemented.
- Fresh full PA Project readback, positive portal financial/file byte access, tenant isolation, revocation and outage/recovery evidence remain required.
- No production PA update, production portal activation, or existing public-link changes are authorized by this staging successor. Stop at the owner production-update checkpoint once staging prerequisites pass.
