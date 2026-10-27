# Embedded Viewer startup diagnostics

This parent-side change pairs with Viewer diagnostics PR309. It diagnoses the
unresolved production client iframe timeout; it does not establish its cause or
authorize model access. Until the paired release is installed, an older Viewer
may remain at `awaiting-shell` while its existing ready handshake works normally.

`ViewerEmbed` probes the exact iframe WindowProxy at the session's exact HTTPS
Viewer origin using a fresh 128-bit nonce for each source-generation effect.
The probe contains only version, type and nonce. At most four probes are sent,
on effect installation and iframe load; there is no session issuance or replay.

Only the agreed exact startup-phase schema is accepted, from that exact origin,
WindowProxy and nonce. Sequence must increase within 1–16. Milestones and HTTP
status are finite allowlists. URLs, model/client identifiers, capabilities,
arbitrary errors and extra fields are rejected. No telemetry is transmitted.
The existing ready/renewal handlers remain the only authority for those states;
even a `ready-sent` diagnostic cannot mark the component ready.

The stage element exposes content-free DOM data attributes for supported browser
inspection: last phase/sequence, bounded milestone history, frame-load count and
last redemption status. History contains at most16 allowlisted entries; it never
retains incoming message objects. No normal client-facing UI text is changed.

Capture ends after60 seconds from effect installation or component cleanup.
A second iframe load is recorded as terminal `frame-reloaded` and closes this
diagnostic attempt: WindowProxy survives navigation, so replacement-document
sequences and queued replies must not be misattributed to the first startup.
This does not interfere with the Viewer's existing authorization or navigation.
An explicitly new parent/session source starts a fresh diagnostics attempt.

Run `node --test scripts/viewer-startup-diagnostics.test.mjs`. Focused tests cover
origin/frame/nonce isolation, malformed/secret-bearing messages, statuses and
sequence replay, probe bounds and failure, time bounds, closure and replacement
documents. Paired actual React/browser acceptance is a separate release gate.
No production grants, credentials, CSP, sandbox, storage or TrueNAS change is
required to qualify this source. Existing revoked grants remain revoked.
