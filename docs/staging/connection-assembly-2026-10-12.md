# Connection workflow assembly — October 12, 2026

This is local combined-candidate evidence, not a production deployment approval or a live staging acceptance certificate.

## Scope

- Prefer authorized native project management routes over legacy mutation routes.
- Keep production binding continuation explicitly opt-in.
- Expose reviewed Directory adoption through the operational connection workflow, with post-read authority checks.
- Expose project inbound review through the normal client workspace.
- Allow explicit PA-first project adoption from a customer's business project list into a new, unused Operations project ID.
- Preserve exact source/customer relationships, native staff authorization, explicit review and frozen idempotency keys after uncertain responses.
- Do not merge existing projects, activate client access, change financial documents or alter existing public links.

## Source composition

Base: `007617483d64425e6e16664273d9c7344731d82c`.

Assembly runtime/UI head: `7c5fdd0dd81330becabdce6b0eaee8c1a148fa28`.

Original source commits integrated in order:

1. `4118539e07751c3fc0ddde7679c6d191b1b501c8` — native project route precedence.
2. `1e34ed12fd9ddc10b7a08eb039a591a93d1cdd80` — opt-in production continuation.
3. `e73502a33b22780423bfc3278726fd8e0d351894` — operational Directory backend.
4. `6bedef2e30b7bfcb724f57046294c64c4c5b9841` — operational Directory UI.
5. `a46a52729a75dca25aaeaeb08197d000536cf5f4` — post-read authority race check.
6. `efab96734cd13ae0ceb61ce9d1adef3988e6bf5e` — operational project inbound review.
7. `06312ecf4cb6692554e5697605cc55a011531436` — operational project adoption backend.
8. `46843cff5e3da6f64f14771faace8acaabed151c` — operational project adoption UI.

## Root verification

- TypeScript `npm run check`: passed.
- Worker and client `npm run build`: passed; existing large-chunk warning remains.
- Four route suites: 30/30 passed, covering native project management, inbound review, Directory adoption and project adoption.
- Operational connection/adoption browser checks: 10/10 passed on desktop and mobile Edge.
- The first browser run used stale built assets; after rebuilding the current source, all checks passed without assertion changes.
- Exact project adoption source commits received an independent clear review, including the bounded 64 KiB, duplicate-free PA response check and negative response tests.
- Six database-backed/core integration suites passed 53/53: native project management, Directory adoption preparation/runtime finalization, project adoption finalization and candidate API validation. The project adoption D1 fixture applies the migration chain; these local fixtures are not live PA calls.
- Combined integration review found a stale generated `NodeJS.ProcessEnv` flag entry. Regenerating with the locked Wrangler version corrected it; `cf-typegen:check` passed. No binding value or deployment was changed.
- Added a combined desktop/mobile browser regression for adoption and native creation coexistence, adoption completion, customer-project refresh, canonical project navigation and inbound proposal review. The delegated run passed 2/2 new cases and 22/22 combined adoption/native-management cases. Its browser-boundary API fixtures prove UI/route-shape integration, not actual remote PA transport or live client access.
- Root independently reran the new coexistence spec: 2/2 passed. Three additional native-action/Directory-adoption suites passed 39/39. Combined root focused evidence is therefore 122 tests across thirteen server/integration files and 12 browser cases; this is not the full repository suite.

Commands run from `apps/operations`:

```powershell
npm run check
npm run build
npx vitest run --config vitest.config.ts test/project-alpha-project-adoption-operational-routes.test.ts test/client-hub-native-project-management.test.ts test/client-hub-project-inbound-review.test.ts test/project-alpha-directory-read-adoption-routes.test.ts
npx playwright test --config playwright.config.ts test/browser/project-alpha-operational-project-adoption.spec.ts test/browser/project-alpha-connections.spec.ts --grep 'operational|PA-first'
npx vitest run --config vitest.config.ts test/project-alpha-project-adoption-finalizer-d1.test.ts test/project-alpha-directory-read-adoption-finalizer-d1.test.ts test/client-hub-native-project-management-d1.test.ts test/project-alpha-directory-read-adoption-runtime-finalizer.test.ts test/project-alpha-project-adoption-finalizer.test.ts test/project-alpha-project-adoption-candidates-api-v2.test.ts
npm run cf-typegen:check
```

## Remaining release gates

- Complete combined database-backed verification and integration-specific review.
- Require successful CI for the exact combined candidate, not merely its base commit's already-passing CI.
- Recover and verify the private staging release/attempt markers before continuing the already-started live automatic-sync acceptance. Do not fabricate markers or repeat uncertain operations.
- Prove the live normal profile update → PA acknowledgement → automatic binding continuation → test-authority cleanup cycle.
- Run combined normal operational workflow acceptance against the exact staged candidate.
- Revalidate client sign-in, authorized data access and revocation against the paired staging release.
- Only then prepare the owner's production PA update checkpoint, with exact revisions and actual production migration/configuration prerequisites.

No production PA deployment, production client access activation or production portal cutover is authorized by this document.
