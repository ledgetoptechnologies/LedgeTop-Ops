# Reduced Team candidate on the installed Operations source

Base: `4a1c05e6f1ff0c32f4c102e54a2c82d4bafba434`.
Source of selected changes: PR #663 net range `0bd57d05..318026fe`.
This is a reduced backport, not the exact full PR. It is an offline candidate only and carries no release authorization.

## Included

- Team heading, profile-origin badges, role-derived Protected Owner badge, concise locked cards, inactive-staff warning, and removal of the unavailable purge toggle.
- Existing Team roster returns access_controls_editable using administrator + global roles.manage and the existing writer's target rules.
- Both role tables protect global owners. Self, inactive-invalid-status and sync-protected target rules remain enforced.
- Target eligibility is fenced in the atomic access-controls write batch, preventing a protected target becoming writable between read and write.
- Existing staff-access-controls route/source regression tests, exact #663 SQL owner predicate Node test and exact #663 mounted auth/ACL/D1 regression suite. The roster browser test is reduced to the included presentation and editor behavior.

## Excluded

No native profile/lifecycle UI, native session probing, Logs eligibility or username editors, onboarding panel, invitation claim entrypoint, new onboarding implementation, migrations, bindings, environment/configuration changes, shared permission changes, Logs host/controller code or package/dependency updates. Existing installed native lifecycle backend remains byte-for-byte unchanged. Keeping its UI out avoids changing the user-facing action surface while its production activation/delegation state is unverified.

Only two runtime files change: apps/operations/src/client/OperationsApp.tsx and apps/operations/src/worker/index.ts. Worker changes are the exact #663 net hunks. Client changes are #663 presentation/access-control hunks with every new native/Logs dependency and mount excluded. Existing assigned work, authentication, native gates, other pages and routes retain installed behavior.

## Validation status and bounded commands

Source whitespace check passed. No tests, build, browser, local runtime or network operation has run for this candidate. No node_modules was installed or linked in the worktree. Lead must admit a free serial slot and an existing compatible dependency tree before execution; do not install dependencies implicitly.

From repository root, first run the low-load Node SQL owner predicate check:

    node --test --test-concurrency=1 apps/operations/test/native-team-owner-roster.node.test.mjs

From apps/operations, run one bounded Vitest worker with no file parallelism (wrap in the admitted process/job timeout and memory controls):

    node node_modules/vitest/vitest.mjs run --config vitest.config.ts --maxWorkers=1 --no-file-parallelism test/staff-access-controls.test.ts test/staff-access-controls-route.test.ts test/team-own-users-mounted-access.test.ts

The mounted suite creates a disposable local D1 runtime and synthetic signing keys. It needs a longer bounded slot (up to 180 seconds for its migration hook); run it separately if the admitted slot is shorter. Candidate tests are pending and their compatibility is not yet established.

After those pass and only with a separately admitted browser/build slot, use the existing Playwright configuration serially for test/browser/team-roster-ownership.spec.ts, plus the existing team-viewer-access and team-assigned-work suites. Do not infer visual acceptance from source tests. No production or staging acceptance is claimed.
