# Employee content framing in Workerd

The full employee transport acceptance exposed a real Worker framing defect: the owned Python gateway returned `Content-Length: 2097152`, but the custom guarded Ops response reached the .NET downloader without that header. The downloader correctly refused it before creating a partial file. No downloader validation was relaxed.

The transport now pipes the existing audited, authority-checked and byte-bounded source into native `FixedLengthStream`. It keeps incremental backpressure, exact range metadata, the original strong ETag, and the existing proof/deadline checks. An explicit caller/deadline abort also cancels an in-flight upstream read, rather than waiting for another source chunk. Every pump rejection is observed. No whole-file buffering, new routes, origins, permissions or deployment settings are added.

`apps/operations/test/employee-read-framing.test.ts` bundles the actual production function into local Workerd with synthetic proof/dependencies and no outbound network. Actual local HTTP verifies full 200, range 206 and zero-byte Content-Length/body/ETag, and contrasts an arbitrary stream with identical octet-stream headers (which loses length). Native tests also cover short/oversized streams, explicit signal abortion of a stalled read, downstream cancellation when the next chunk arrives, and authority denial. This is framing acceptance, not full identity/D1/gateway acceptance.

Pinned Workerd's native fixed stream does not notify the producer immediately when its readable is cancelled while the upstream read is stalled: writer.closed remains pending, writer.ready resolves, and even a zero-byte write succeeds. Downstream cancellation is detected on the next write; explicit caller abortion/deadline still unblocks the read. These tests do not claim physical socket-disconnect cancellation. Incoming request.signal requires the separately reviewed staging `enable_request_signal` opt-in. The existing maximum transfer deadline remains a bound if no disconnect signal arrives.

Node-only legacy suites explicitly import `node-fixed-length-stream.ts`, a scoped test primitive. It cannot qualify native HTTP framing and is not imported by production or real Workerd bundles. The legacy final-route denial regression uses a slow upstream so it still proves denied bytes are replaced by a static 403 and upstream cancellation occurs when the next chunk arrives.

Official references: [Response Content-Length](https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header), [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream).

Validation (local only):

- `node node_modules/vitest/vitest.mjs run test/employee-read-transport.test.ts test/employee-read-service.test.ts test/employee-read-routes.test.ts test/employee-read-framing.test.ts`: 138 passed.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.

No containers, cloud resources, client files, credentials or provider registrations were changed by these checks. Full Docker/TLS/.NET transport acceptance is a separate follow-up using the real employee Worker composer.
