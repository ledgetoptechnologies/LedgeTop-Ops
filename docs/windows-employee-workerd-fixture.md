# Employee full-Workerd fixture

`employeeWorkerdTransportFixture` runs the full actual Ops Windows staging
composition under local Miniflare/Workerd. It audits the raw source exports
against the reviewed policy and retains all16 runtime classes plus default
fetch/queue/scheduled delegation. Its existing employee authority helper may now
seed a supplied actual OPS_DB binding/runtime. The default helper still creates
and owns its blank local runtime. Supplied-runtime failure cleanup belongs to
the caller, not the helper; the outer fixture disposes its runtime on any error.
The complete frozen223-migration inventory and real native admission/root/grant/
revoke commands are unchanged. No PA employee identity or shadow grant is used.

Real locally generated RS256 assertions carry the fixed expected staging issuer,
staff audience and the synthetic admitted Alice/Bob subjects. Workerd runs the
actual signature/claims checks and native Ops D1 authorization. There is no jose,
identity, router or reader mock. Only the exact issuer's certs GET receives the
synthetic public key via an outbound-service intercept. All other network
requests are denied except the exact fixed gateway POST described below.

The full composer keeps its existing staging hostname guard. The fixed virtual
`https://employee-gateway-staging.ledgetopdroneservices.com/v1/read` POST is mapped
through a trusted test-only callback to an owned ephemeral IPv4-loopback HTTPS
listener. Neither DNS nor the product origin/port checks change. The separate
transport harness must enforce that captured destination, explicit ephemeral CA,
certificate/hostname validation and no redirect. HMAC headers and body pass
unchanged; human Access assertion/cookie/Authorization headers are refused at
the gateway boundary. A fresh standard Miniflare Response wraps the actual
returned status, headers and stream without inventing content or buffering the
whole file. Gateway key/IDs/fingerprint and callback are copied/captured before
asynchronous setup; handle and queue keys are distinct synthetic32-byte values.

The boundary-only opt-in acceptance runs actual Workerd and the223-migration
D1 chain, verifies Alice root discovery, Bob's lack of grant, tampered signature
401, admitted access reaching the gateway boundary and post-revoke403 without a
new gateway call. Its gateway deliberately returns unavailable; this is not a
fake successful file/list proof. Actual Python Docker, physical TLS validation,
.NET parsing/resume and byte SHA evidence belong to the separate transport
harness. No physical gateway, TLS or file-transfer success is claimed by this
boundary-only test.

From `apps/operations`:

```
node node_modules/vitest/vitest.mjs run --config vitest.employee-workerd.config.ts
node node_modules/typescript/bin/tsc --noEmit
```

The fixture uses the pinned existing Miniflare/workerd graph at local
compatibility date2026-08-06; dependencies are not upgraded. Default test discovery
does not run this acceptance. All resources are local synthetic Miniflare state
and disposed in finally. No credentials, production data, cloud mutation,
staging server, EH execution, NAS access or provider installation is involved.
The fixed virtual hostname and declared metadata do not prove a remote physical
binding or authorize activation.
