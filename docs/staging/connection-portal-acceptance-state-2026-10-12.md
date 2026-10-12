# Connection and portal acceptance state — October 12, 2026

This is a current-state audit, not production approval. Historical successful tests and reachable pages do not establish current end-to-end acceptance.

## Release identities

- PA connection candidate: draft PR #198, `5c07268f1633e4d712bb31bcecabd2b55f14a00c`; five GitHub checks passed on recheck.
- Combined Ops candidate: draft PR #156, published head `596dc8ab30fc14b42e0945098b75ea37776428b9`, based on `007617483d64425e6e16664273d9c7344731d82c`.
- Reviewed local correction: `298c8418076938a7ea24d91baae5dc8d28cc06bd`. This updates the exact source-contract configuration pin for the two reviewed default-off operational flags and asserts their uniqueness/default-false values. It does not enable a feature.
- CI run `38297498664` is for the published head, not the local correction. All four desktop/mobile browser jobs, Client application, ops-sync, incoming pickup and thumbnail jobs passed. Ops application tests remain running; source-invariants failed at the stale hash in the first repository-contract step. A new exact-head run is required after the correction is published.
- Last provider-verified staging pair: Ops `a6fd8a5d-0c61-4e02-8885-6325f77e2236`, Client `e09964d3-4cc0-4eca-aaa8-dd386fbf624d`. These are distinct from the combined source candidate above. Automatic outbox dispatch remains paused in that verified configuration.

## Acceptance matrix

| Requirement | Current evidence | Remaining proof |
| --- | --- | --- |
| PA API reads and capability discovery | Fresh normal Ops UI verification: Directory 15, Projects 5; client create/profile-write capabilities advertised | Write capability advertisement alone is not a successful mutation or acknowledgement |
| Combined normal Directory/project workflows | Build, types and focused route/database/UI tests pass; combined source is in PR #156 | Exact-head CI, staging deployment and normal live operational workflow acceptance |
| Automatic profile update and binding continuation | Full-schema local recovery/continuation tests pass; current live dispatch is paused | One normal synthetic edit, PA acknowledgement, automatic continuation, canonical state verification, exact temporary-authority cleanup and restored window settings |
| Client login/page reachability | Existing Client staging session loads `/portal` | Explicit enrolled and genuinely distinct-principal observations tied to the tested release |
| Selected file access | Current normal browse action returns no shared deliveries; browser helper tests pass | Exact selected fixture listing, nested traversal, preview/download byte length and SHA-256, exclusion of unshared objects, old-handle denial after revocation |
| Financial visibility | Current source has UI → verified principal → private RPC → current billing/mapping → PA transport; local financial tests pass | Positive scoped synthetic document/action-link read, distinct-principal denial, same-session denial after current revocation; current UI reports financial information unavailable |
| Production deployment readiness | PA candidate CI is green; source path boundaries audited | Actual production pending migrations/configuration inventory, final merged revisions, owner PA update checkpoint and separate bounded validation plan |

## Local evidence added during this audit

- Five Client financial/service-home files: 30 tests passed.
- Two Ops financial reader/wire files: 8 tests passed.
- Three browser-context acceptance/principal-observation scripts: 30 tests passed.
- Real Miniflare/D1 fixtures substantiate permission removal, revocation and revoke/regrant ABA behavior. Sequenced mocks substantiate mapping/authority changes during an in-flight read. These are deterministic local tests, not live remote acceptance.
- First CI repository-contract command rerun locally on the correction: 211 total, 208 passed, zero failed, three Windows symlink-policy skips.
- Earlier combined-candidate evidence remains in `connection-assembly-2026-10-12.md`; do not add these counts to historical reruns and present the sum as unique coverage.

## Evidence recovery and diagnostic limits

- Committed source from the removed worktrees has been recovered. Private, uncommitted `.private-releases` and `.tmp-checks` artifacts are still missing from the original checkout path; the owner is restoring them.
- Recover the actual artifacts, verify hashes and private file permissions, and reconcile each prior attempt before resuming its live workflow. Do not fabricate an attestation or repeat an uncertain operation because its local marker disappeared.
- A fresh hidden in-app tab restored browser interaction and verified the current Ops session. An attachment timeout on an older tab was not evidence that the account lacked permission.
- The old synthetic scalar-head diagnostic returned `blocked / local`. Bounded read-only database inspection found one active mapping/current relationship and a validated relationship acknowledgement at revision 3, while the latest observation is revision 4. The diagnostic requires those exact revisions to match. It is not a current dynamic profile-head capture and must not be used to retry a superseded command or claim automatic-sync acceptance.

## Production exposure boundary

- The dedicated staging entrypoint owns the authorized staging exposure for native recipient, workspace publication, delivery authority, billing authority and billing-permission owner surfaces. Workspace/delivery/billing owner HTTP surfaces are intentionally isolated from the standard entrypoint. Native recipient is also mounted there, but its handler remains staging-gated and production-inert. This is not missing staging business logic.
- Future production exposure must reuse the audited business handlers behind configured HTTPS-origin checks, normal staff permissions, default-off flags and the exact required private service bindings. Generalize the operational exposure policy narrowly; never expose the complete staging wrapper, synthetic fixtures or maintenance-authority pages wholesale.
- The existing mounted `/api/delivery/native-grants` path is separately production-compatible and default-off. It is not automatically interchangeable with the newer native-recipient/workspace-publication lineage.
- Financial and service-metadata private readers are production-compatible by code and default-off. Production consumer configuration and activation remain separate from proving the source implementation exists.

## Next execution order

1. Retain terminal diagnostics from the active CI run, publish the reviewed correction, and require all checks on the resulting exact revision.
2. Recover/verify private live-attempt evidence, then finish the already-started automatic-sync acceptance with exact cleanup. No blind replay.
3. Stage the combined operational candidate with preserved settings and run normal Directory/project adoption/create/edit/conflict-review flows.
4. Complete paired Client enrollment, scoped financial/file reads, distinct-principal denial and revocation acceptance against the exact release pair.
5. Prepare the owner's production PA update checkpoint from actual production read-only state: revisions, pending migrations, scoped credentials, configuration, backups and safe validation order.

No production PA mutation, production recipient activation, production portal cutover or existing public-link change occurred in this audit. The goal remains incomplete until its production validation and client-access requirements are actually satisfied under the appropriate owner checkpoint.
