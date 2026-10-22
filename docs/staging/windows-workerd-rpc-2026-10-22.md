# Actual local Worker RPC transport acceptance

Root independently passed the direct RPC acceptance in79.71s and the layered
.NET acceptance in82.43s. The latter traversed the existing .NET client and
Downloader, loopback TLS ingress, full Client staging composer, real named Ops
WorkerEntrypoint service binding, full Ops staging composer and local D1/R2.
The adjacent JSON contains only nonsecret proof fields from the retained receipt.

The2MiB file was interrupted at16384 bytes, resumed with206, and matched its full
SHA-256. Invalid TLS pin and invalid RS256 signature were refused. After a real
Ops-only authority revocation, the saved handle returned404 while the Client
grant was explicitly checked to remain active. One mandatory content-start audit
event existed. No zero-R2-read claim is inferred from denial in this harness.

This found and fixed a staging build defect: raw library `export *` leaked cron
strings into Workerd entrypoints. Static source export equality had missed the
failure. The generator now preserves all16 Ops and13 Client runtime classes plus
default handlers, explicitly classifies helpers, and rejects unknown source or
missing runtime exports.20 constructor/actual-bundle tests pass independently.
Both full Worker compositions started successfully; no reader-only host or
manually substituted reader function is used in the final acceptance.

The fixture bundles Worker source freshly with esbuild. Its Node-only bootstrap
shim does not enter Workerd. JWT signatures are verified against synthetic JWKS
served only at the exact expected test issuer URL; every other outbound request
is denied. The test uses a historical local engine compatibility date supported
by the locked Workerd package; it is not current deployed-runtime qualification.

Independent source review verified named binding targets, complete wrappers,
outbound restrictions and lock/shared-source provenance. Both ordinary app type
checks also passed in the author tree; integration graphs were exercised rather
than claimed to be exhaustively typechecked.

No deployed Worker, cloud migration, production key, human Access sign-in,
real R2 content, EH execution, NAS access or global certificate trust changed.
The ephemeral test certificate and temporary synthetic output were cleaned up.
Live staging physical/migration/private-key gates, human session acceptance,
employee server acceptance, installation/signing and writable-sync restrictions
remain separate requirements.
