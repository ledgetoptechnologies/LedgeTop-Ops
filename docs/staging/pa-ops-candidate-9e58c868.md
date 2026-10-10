# PA–Operations candidate 9e58c868

- Ops revision: `9e58c8682f4b25248f4ed678f5fc39bf02e22047`.
- Review branch: `codex/staging-portal-acceptance-tooling`; PR 146.
- Exact-revision CI: https://github.com/ledgetoptechnologies/LedgeTop-Ops/actions/runs/38039209844. It was in progress at this checkpoint, not an accepted release.
- Production PA, production portal activation and existing public links remain unchanged.

## Latest continuation checks

- Exact-revision CI now has eight successful jobs, including Client typecheck/tests/build and all four desktop/mobile browser jobs. Operations and the final source-invariant step remain in progress at this observation; do not count them as passed.
- Fresh GET-only provider preflight still reports active version `dbe5d1b6-05bd-4aa2-b5bb-273493be57da`, 142 live bindings, 143 expected candidate bindings, preserved runtime, and both recovery/drain disabled. No configuration file was generated and no remote mutation occurred.
- Read-only native staff workflow inspection found no supported executor/API/UI for changing existing staff `native_directory_grants`. The legacy Team controls and onboarding initial-grant materialization are not substitutes. A narrow paired scalar-test authority lifecycle is being implemented separately, not a broad owner bypass.
- Read-only Project acceptance inspection found that the organization-owned candidate needs `drone-services-staging`, whereas the existing Project compiler targets the synthetic client's different business area. A separate exact organization-scope compiler is being implemented; candidate discovery must not be made global to avoid this check.
- Fresh `origin/main`/`FETCH_HEAD` resolve to `bb8422c77bbcad9093662e8da9d235c40d27282d`. The prior branch inventory's 58 merged branches all have registered worktree dependencies, so none qualifies for deletion under the standing cleanup boundary. No branch was deleted.
- Source-layout and staging release-preservation regressions passed 29/29 in this continuation. These check local contracts/configuration preservation, not live synchronization.
- Follow-up local test-only correction closes the entire Vite server even if Miniflare disposal fails and uses Node's explicit `{timeout:240_000}` options. The intact 0001–0184 acquired-client/organization scalar fixture passed 1/1 and exited normally in 75.87 seconds. This follow-up is not part of pushed `9e58c868` and has not received remote CI; it does not prove the current remote run was stalled for that reason. Its first sandboxed attempt failed before fixture execution because workerd could not start; the narrowly elevated local rerun passed.

## Completed local evidence

- Corrected mixed-scope recovery authority: 17/17 tests, including real 0001–0184 atomic provision and paired revocation.
- New Project authority compiler/apply: 17/17 pure tests; 3/3 full-schema tests. The pending-work negative first creates a genuinely valid pending relationship command, then verifies atomic rejection.
- Final scalar settlement validator: 27/27 pure tests; acquired linked-client and organization full-schema writer/dispatcher/cleanup: 1/1. PA HTTP responses are mocked in this local fixture.
- Dispatcher: 12/12 focused tests; subsequent selected regression passed with newer-delivery, stale-head and conflicting-generation assertions. TypeScript passed.
- Release configuration preservation: 7/7 tests.
- Operations application build passed. Worker bundle SHA-256: `53c54d3bf01b1c3d7c12c402c57acca9063bfc93a33bf15005230aa26d4c6356`; Client index SHA-256: `2697856c3fb827b0ab0fccb2e7d2dfda14752a5597eb27e3a9fc9e9b2b933e43`.
- Wrangler 4.118.0 staging-entrypoint dry run passed and produced a separate local bundle, SHA-256 `ce293ffe4ec4c7fa1f0899b0575257a67a94082ca4787b4db9e492d6cbe76ba8`. The old committed baseline was used only for compilation; its stale variables must not be deployed over live staging settings.

## Next release and acceptance gates

- Finish exact-revision CI; do not promote a failing or incomplete run.
- Resolve the separately requested process-scoped Windows script-policy approval before generating the restricted live configuration file. Do not change machine-wide policy or bypass this checkpoint.
- Capture fresh provider state, preserve complete live bindings/runtime/resources/schedules, and verify any uploaded candidate before promotion. Recovery and Directory drain remain disabled in the initial release.
- Complete reviewed synthetic relationship recovery and close its six-grant window.
- Use a separately audited normal scalar-edit authority lifecycle. The historical recovery packet is not reusable after a customer version advance. Prefer an existing supported product grant-management flow if it satisfies the same scope, audit and cleanup requirements.
- Prove actual PA acknowledgement/readback for a normal customer edit and one-to-one Project adoption.
- Prove recipient identity enrollment, selected-folder listing and actual bytes, exclusion/cross-principal denials, then revocation and cleanup.
- Complete outage/recovery validation before the owner's production PA update checkpoint. This file does not authorize or prove a production cutover.
