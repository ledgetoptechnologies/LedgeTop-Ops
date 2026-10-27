# Embedded startup diagnostics

`/viewer-startup-diagnostics.js` is a separate classic same-origin asset in the
document head, before the main module dependency graph. Keep that ordering in
production output: importing diagnostics from main.js cannot diagnose a failed
module dependency. Existing CSP, frame ancestors, authorization, renewal and ready
message handling are unchanged.

The parent may send exactly `{version:1,type:'ltds-viewer:startup-probe',nonce}`,
where nonce is 32 lowercase hexadecimal characters. The child requires the exact
parent window and a canonical HTTPS message origin. The first valid probe binds
that source, origin and nonce. Replies target that exact origin. Later probes do
not replay history or change the binding or expiry. The pre-redemption channel
does not establish parent authorization: its payload must remain content-free.

Replies contain exactly version 1, type `ltds-viewer:startup-phase`, nonce, phase,
sequence (1–16), plus status only for `redeem-http`. Phases are `shell-loaded`,
`module-started`, `redeem-started`, `redeem-http`, `session-applied`, `init-returned`,
`ready-sent`, and `bootstrap-failed`. HTTP status is limited to 200, 400, 401, 403,
404, 409, 410, 429, 500, 502, 503, 504, or `other`.

History is memory-only, at most 16 events, and cleared after 60 seconds measured
from classic script execution. The message listener is removed then. A delayed
timer cannot extend the channel because probes and marks also check monotonic
elapsed time. Top-level Viewer windows install no diagnostics channel.

No URLs, identifiers, grant values, access tokens, error strings, model data,
storage access or external telemetry belong here. `init-returned` means only the
synchronous initializer returned; it does not prove rendering finished.
`ready-sent` means the existing controller send returned true, not that a parent
received or accepted it. Only the existing validated ready handshake controls
parent readiness. Absence of a phase is evidence of missing instrumentation or
progress, not proof of a specific network/CSP failure.

The paired parent must check exact configured Viewer origin, iframe contentWindow,
nonce, strict payload shape, finite phase/status/sequence, and its own event/time
bounds. Diagnostic messages never grant access or substitute for ready.

Validation: `npm run build`, then `node --test
test/viewer-startup-diagnostics.test.js test/viewer-session-storage-runtime.test.js
test/viewer-session-recovery.test.js`. Tests exercise the actual classic script
and production bootstrap functions, including denial, initializer failure,
missing controller, message rejection, fixed expiry, and built asset ordering.
These tests do not prove the unresolved production Client iframe behavior.
