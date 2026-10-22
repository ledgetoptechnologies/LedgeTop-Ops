# Explicit ownership of rejected employee download requests

`/api/staff/files/downloads/:fileHandle` now owns a request-scoped abort controller, combined with the incoming request signal using native `AbortSignal.any`. Only a successful final length/range/authority/expiry validation hands the content response onward. Every rejection or thrown final check aborts ownership before discarding acquired content. Backend static errors retain their existing body/status while request ownership is also aborted. Native fixed-length framing, gateway byte bounds, audit, identity, paths and wire metadata are unchanged.

The focused real Workerd regression bundles the production router, gateway transport, handle codec and native FixedLengthStream. Authentication/authority are controlled test-only modules, not proof of identity or D1 admission; an adapter waits for the real source's second read to stall before returning its response. The source emits one byte and then permanently stalls, with no next byte and no deadline wait. Final authorization denial, exception, expiry, total-length mismatch and range-total mismatch all return only static 403/503 errors and cancel that source. A test-only cancel observer verifies the owned signal is already aborted BEFORE discard.

Counterfactuals remain precise: removing only owned.abort still allows native discard to cancel a pending first write in this fixture, but loses the abort-before-discard guarantee. The historical throwing-recheck path had neither explicit abort nor discard and reproducibly leaves the stalled source alive. The test checks both outcomes rather than claiming all prior denial paths leaked.

This fixes server-rejected response ownership. It does not establish physical incoming socket-disconnect detection or remote/offline revocation semantics. No configuration, public HTTP contract, production deployment, NAS or remote job changed.

Local validation from `apps/operations`:

- `node node_modules/vitest/vitest.mjs run test/employee-read-rejected-stream.test.ts test/employee-read-routes.test.ts test/employee-read-transport.test.ts test/employee-read-framing.test.ts`: 124 passed.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.

References: [Workers web APIs](https://developers.cloudflare.com/workers/runtime-apis/web-standards/), [AbortSignal.any](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static). The repository's generated Worker types declare the native API; actual Workerd execution qualifies its use here.
