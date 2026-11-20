# Battery reference names: source candidate

Hub task `475e9703-5941-4eed-a85d-0aeee621ad20`, claimed by Codex revision 2,
independent reviewer Claude. Fresh Hub overview paused=false. This receipt is a
durable progress handoff; exposed Hub tools do not support task progress/candidate
writes, so it is not a task update or completion record.

Base: remote main `0bd57d05ae4191dbe8d5bbb78a5e32c732eb6813`, fetched November 19,
2026. Target UI surfaces are already on main. Local branch
`codex/logs-battery-reference-20261119`; no shared branch edits, push or deployment.
Current PR625/650/653 heads were read from GitHub and match the earlier receipts:
`73925adc`, `654065cc`, `e00e0046`. Enumerated all current local and origin refs
with `git ls-tree` for domain migration 0007: no collision. Reserve
`apps/logs/migrations/0007_battery_references.sql` for this task. Keep pairing
0004 untouched; the local-only migration ledger is separate.

The new relation keys names by aircraft and battery, with normalized uniqueness
within aircraft. Save/rename/clear use existing flight_logs.import authority,
atomic audit+mutation, and keyed local RPC with fresh directory authority even on
replay. Ordinary viewers cannot write. Battery serials, ids, flights and historical
associations are untouched. List/detail/filter/overview/health expose aircraft name,
reference and serial consistently; search includes raw serial and reference.
The battery selector binds both aircraft and battery when choosing a named pair.
The detail editor freezes uncertain saves for retry with the same input and key.
Pending editor input survives component state only, not navigation/full reload;
the service's keyed receipt remains durable. No claim of cross-reload UI recovery.

## Validation status at source commit

- JS module and plain TypeScript `node --check`, TSX esbuild syntax-only parsing,
  and `git diff --check` passed. Parsing does not resolve imports or check types.
- New synthetic SQLite tests cover fallback, rename/clear, normalized uniqueness,
  cross-aircraft reuse, search/pilot scope, all read feeds, unchanged history,
  unauthorized/invalid writes and atomic audit rollback.
- Added local HTTP RPC replay/revocation test, Ops route/remote tests and two
  browser cases for editable/read-only views, lost response retry and clear.
- No functional test was run before this commit. Lead admits only the direct
  in-memory SQLite file next: one process, heap 256 MiB, outer 30 seconds.
  HTTP/workerd/Vitest/build/Playwright remain queued with Lead QA.
- Suggested Ops dependency sibling `ops-embedded-load-timeouts-20261119` has
  different package/lock blobs, so it is not qualified as matching runtime
  dependencies. Its esbuild executable was used solely for syntax parsing.

## Non-device staging entry prerequisites (source/receipt only)

Read the existing gap-readiness and compose receipts under `P:/Projects/_lead`.
They identify the healthy existing Logs pilot; do not stand up the compose draft
as a second pilot. The receipt's account, binding, tunnel and image observations
are historical evidence, not fresh live verification in this lane. Reverify actual
account/resource ownership and exact active image before staging changes.

Source confirms username bootstrap and active, device-eligible directory lookup
(`device.mjs`, `directory-client.mjs`), with approval in that pilot's own Ops
session. Confirm existing username/eligibility/registration; never reuse production
tokens. The private Logs route requires the existing Ops/device-proxy Access
identities and functioning Logs-to-Ops directory path. Do not expose credentials.

`config.mjs` allows a blank DJI key; `decoder.mjs` then stays waiting_for_key
without claiming work. A healthy host or synthetic decoder result therefore does
not prove real encrypted RC Pro2 decode. Confirm parser/key readiness and egress
policy before a real sample. Admit one owner-selected sample using a safe selection
mechanism (the current app scans its granted folder). No real file access/copy,
upload, app/device/driver changes, key inspection or live pilot mutation occurred.

After independent source review and admitted local checks, stage this exact source
with migration 0007 on the existing pilot through the authorized release owner.
Capture real sample decode/display and reference save/rename/clear/search/health
evidence, then Beau's visual feedback. Task acceptance remains open until then.
