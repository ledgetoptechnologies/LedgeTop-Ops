# Local service and financial integration

- Scope: local integration only. No push, deployment, production client activation, or public-link mutation.
- Base service slice: `207000b3a3e2a84889411c3d0b84c61d63113162`.
- Financial foundation and inventory acceptance: original commits `e0de43c0`, `a5fca7b2`; private service-binding slice `1eda3382`.
- Includes required financial response-boundary, bounded transport, trusted mapping and shared-contract prerequisites. Combined code includes the financial route/display slice and scope/privacy corrections through `c8a8ba8a`.
- Preserves the extracted canonical resource fixture and audited service-definition writer. Operations applies the verified 0001–0187 prefix followed by 0188, 0189, 0190, 0191, 0192 in order. Client applies its canonical prefix and 0224–0228 suffix.

## Evidence

- Financial boundary/transport/mapping/shared contract/private reader and service route/component tests: 89/89 passed, seven files.
- Client trusted financial consumer: 4/4 passed.
- Operations and Client typechecks passed.
- Canonical resource lifecycle: 1/1 passed, 115.87 seconds, with service creation through the production audited writer.
- First financial collection failed because prerequisite modules were not yet integrated; that condition was corrected before the passing focused tests/typechecks.
- Next full financial lifecycle run ended with local `EADDRINUSE` during migration application, not an accepted application success. The subsequent run at session7228 is terminal **PASS: 1/1, 112.69 seconds**. It proves the integrated 0001–0192 financial/service lifecycle, including trusted financial collection and post-drift denial, on local D1.
- Integrated financial route/summary/consumer/browser-decoder suites after scope/privacy corrections: **12/12 passed**, four files; Client typecheck and build passed.
- Mounted financial authority A→B transition regression: **2/2 passed**, desktop and mobile. While the replacement response is deferred, the previous authority's financial link is absent; only the new authority's link appears after resolution.
- Actual private financial entrypoint method wire-boundary unit suite: **3/3 passed** at `f905f3a7`. This covers default-off, JSON-string success and oversized-envelope denial; it is not live cross-Worker RPC acceptance.
- Client financial decoding reconstructs only allowlisted document fields and rejects unexpected private fields and duplicate grant IDs. Display keys include authority/grant/revision so equal document IDs in different homes do not collide.

## Release exclusions

- This branch still contains historical 0190 bytes. The separate sync-correction worktree is refining the bind/update authorization guards; its final bytes and exact migration hashes must be deliberately integrated.
- Full release pins have not been advanced to 0192. Do not use the old 0188–0190 suffix runner to apply a 0191/0192 deployment.
- Local financial route/display tests pass; live staging acceptance remains required. Named service-binding configuration must be wired deliberately with default-off gates; merely exporting the private class is not a deployed binding.
- No production PA update checkpoint is ready from this local evidence alone.
