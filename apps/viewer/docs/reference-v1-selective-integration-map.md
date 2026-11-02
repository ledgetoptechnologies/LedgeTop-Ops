# Reference-v1 selective integration: blocked dependency map

This local review map is not an integrated runtime or release plan. Baseline: main `dc8cedfe953ce75eb2f65de846de74d076b820f8`, workspace draft #406 `b489c4bf738befcad4c7867869117c9cab41b5e3`. #406 replays the workspace changes from Claude's #347 and adds hierarchy persistence and controls. Preserve those changes and their tests.

Candidate landmarks, not an approved cherry-pick list:

- `57f1f311`, `c13b7d28`: dormant reference provider and options fingerprint.
- `635fceb3`, `538543cb`, `413d5c76`: synthetic coordinator and attempt journal; later catalog identity, capacity, custody and migration-identity changes are entangled with that journal.
- `a100f0e7`, `bc0c9f00`: reference protocol identity and draft attempt binding; GCP snapshot and source custody follow in the same chain.
- #407 `dbb267a6`: isolated result range-resume sibling, not an ancestor of #409.
- #408 `d67f2525`: dormant transfer outbox and deterministic token recovery sibling; its own documentation excludes secret provisioning, worker authentication and NAS immutability.
- #409 `7b8e9271`: atomic broker fixture and six-field ACK check; its design note explicitly holds status reconciliation without a verified durable grant digest and does not prove restart/owner-handoff recovery.

The #409 history includes v41 and v42 plus v44–56; #408 adds v57–59. The #406 baseline reserves v41 and uses v42. Before copying a migration, reconcile exact version, name, content and deployed identity, including the separately maintained GCP branch; do not renumber an already deployed migration. Catalog startup hooks and schema guards must not be copied independently of their required schema, compatibility and restore logic. No trusted transactional broker outbox, authenticated receipt authority, source pin, physical sender fence or production secret lifecycle is established by these fixtures. No-fallback and persistent exact replay after interruption cannot be claimed by composing the existing candidate fragments.

An earlier separate merge trial of #406 and #409 produced conflicts in these eleven files:

- `apps/viewer/docs/workspace-hierarchy-api.md`
- `apps/viewer/server/database.js`
- `apps/viewer/server/processingRepository.js`
- `apps/viewer/test/workspace-brand.test.mjs`
- `apps/viewer/test/workspace-hierarchy.test.js`
- `apps/viewer/test/workspace-hierarchy.test.mjs`
- `apps/viewer/test/workspace-load-errors.test.mjs`
- `apps/viewer/test/workspace-task-layout.test.mjs`
- `apps/viewer/workspace-hierarchy.mjs`
- `apps/viewer/workspace-projects.js`
- `apps/viewer/workspace.css`

The separate `viewer-workspace-reference-integration` worktree remains intentionally unmerged and uncommitted for inspection. Its unresolved state is not an integrated baseline.

The smallest safe next work is a jointly reviewed dependency and migration-identity matrix plus explicit ownership of broker/source/receiver contracts. After those gates are resolved, port cohesive, independently validated components to an isolated draft and exercise process restart, uncertain commit, immutable intent, rejection without fallback, hierarchy upgrade and existing-writer compatibility. Keep the reference execution lane hard-off. Do not copy unrelated GCP, client or Operations changes merely to make tests pass. No code port, migration, deploy, or real job is authorized by this map.
