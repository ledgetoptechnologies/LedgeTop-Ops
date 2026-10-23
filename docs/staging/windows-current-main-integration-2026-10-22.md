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

The first physical employee test exposed a runtime framing gap: the gateway
supplied the expected length, but the custom Worker stream lost it and .NET
correctly refused the response. Repair `55e2934a` uses native fixed-length
framing without buffering the file or weakening client validation. Root passed
138 focused tests, five joined D1 tests, Ops typechecking and the actual full
employee transport on this combined source. The latter passed in 73.41 seconds,
including verified 2 MiB resume, TLS/signature rejection, other-user denial,
stale-version rejection and post-revoke denial with zero later gateway calls.
The safe receipt is `windows-employee-workerd-2026-10-22.json` beside this file.

Staging composition now opts enabled Ops into incoming request signals while
preserving other flags and rejecting an explicit opt-out. Production config is
unchanged. All 38 constructor/bundle/preflight tests pass. Physical browser
disconnect cancellation remains unverified; cancelling a native readable may
not stop a stalled upstream until another chunk or the existing deadline.
Explicit caller/deadline abortion is tested. See the framing document for that
bounded resource limitation.

Follow-up `2819be31` (combined equivalent `76fc9887`) adds request-owned
abortion before discarding server-rejected content. The independent reviewer
and root combined-source run each passed 124 focused tests, including an actual
Workerd source that emits one byte and then stalls during final denial, thrown
authorization, expiry, length and range checks. Root combined-source Ops
typechecking passed. The historical thrown recheck bypassed discard and left
that source alive; native discard alone already cancels the pending first write
in the other counterfactual. This test proves the explicit cleanup order without
claiming physical socket-disconnect detection. Details and exact test scope are
in `../windows-employee-rejected-download-abort.md`.

The separate opt-in large run also passed with native framing: 3,221,225,489
bytes, resumed from 2,148,532,241 (beyond signed 32-bit range), with exact full
and resumed content lengths and verified SHA-256. Statuses remained
200/206/403/412/403, with two content-start audits and no gateway calls after
revocation. This is actual local full-Workerd acceptance, separate from the
earlier Node-adapter proof. Root reviewed the immutable test and receipt rather
than duplicating that large transfer after its independent ordinary run. It
does not qualify standalone Workerd or hosted Cloudflare memory: the measured
Node test host peaked near 2 GB. Owned volume and other fixture cleanup passed.
Review additionally found an uncertain volume-create acknowledgement edge;
cleanup-only follow-up `0ea5b4ae` now attempts removal and checks absence even
when creation did not report success. An actual empty-volume lost-acknowledgement
fault verified that path, without allocating or repeating the large transfer.

These checks use synthetic, local resources. They do not establish live staging
or production transfer acceptance, real user sessions, remote R2 byte access,
Explorer placeholder callbacks, offline pin/eviction, a signed installer, or an
installed update/uninstall lifecycle. The Cloud Files code remains inactive.
Remote staging migrations, reviewed bindings/keys and the separate protected EH
execution authorization remain required. No TrueNAS access was used.
