# Windows candidate on current main

This source-only candidate combines main `77eb072a0aadc8adefae0a6a5cdd068941180794`
with the reviewed Windows transfer candidate `306273391fc7b38dcfc4b69a868d6fb4ad26e307`,
the actual Workerd staging composition `cb6a158377c8fe3b94105b71c41bc0d6b7915071`,
and inactive Cloud Files foundation `4810e072a7f41dfe655b2d5d4c254b8f43639718`.
All three merges completed without conflicts. Employee Workerd fixture
`0c6bf07b505ffcd050b401702b48b34401f1c78d` is applied afterward.

The integration branch is `codex/windows-staging-reviewed-candidate-20261022`.
This does not change a production or staging deployment, activate a provider,
publish an installer, or authorize Engineering Hub execution. Claude owns the
separate portal redesign; this candidate adds no portal UI redesign.

## Independent checks

Fresh, private-to-this-worktree dependencies were installed with each app's
committed lock using `npm ci --ignore-scripts --no-audit --no-fund`. No dependency
junction or another worktree's installed source was reused. Lock SHA-256 values:

- Client: `910ef2fe80303d2367f1937a3569b130f38bea52da9fc11102c9a76ce5f0a535`
- Ops: `451bdfea55e886872c8ef93cef5272bdeccefe0c9fbe65be9df2c2bc9cf2fdec`

Checks passed on the combined source:

- Both ordinary Client and Ops TypeScript checks, including the added employee fixture.
- 34 staging constructor, actual bundle/export-policy and read-only preflight tests.
- 66 targeted Client delivery-route and staging factory tests.
- 86/86 .NET transfer and inactive Cloud Files groups.
- 19/19 desktop app groups, including rendering its synthetic screens.
- Actual .NET -> owned loopback TLS -> full Client Workerd -> named full Ops
  Workerd RPC -> local D1/R2 acceptance: 1/1, 90.67 seconds total. This exercises
  resumable verified bytes and Ops revocation with the Client grant still active.

The combined RPC run was performed before the test-only employee fixture was
added; that addition does not change either product composition or the Client
RPC lane. Ops typechecking was repeated afterward. The separate employee
boundary fixture passed on its immutable source and is not a physical gateway
or transfer success claim.

## Remaining release gates

These checks use synthetic, local resources. They do not establish live staging
or production transfer acceptance, real user sessions, remote R2 byte access,
Explorer placeholder callbacks, offline pin/eviction, a signed installer, or an
installed update/uninstall lifecycle. The Cloud Files code remains inactive.
Remote staging migrations, reviewed bindings/keys and the separate protected EH
execution authorization remain required. No TrueNAS access was used.
