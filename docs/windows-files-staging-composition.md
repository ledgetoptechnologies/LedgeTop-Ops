# Executable Windows staging composition (not activated)

The missing source/build connection is now concrete. The two isolated Worker
composers are `apps/operations/src/worker/windows-files-staging-worker.ts` and
`apps/client/src/worker/client-portal/windows-files-staging-worker.ts`.
They wrap the existing staging Ops main and ordinary Client main respectively;
production mains and Wrangler configuration are unchanged.

Only these path families are intercepted, for every verb and including their
bare roots: `/api/staff/files`, `/api/admin/employee-files`, and Client
`/api/client/operations/data/{windows-catalog,windows-successor,queue}`. A claimed
path never falls through after a factory 401/403/404/405/503. Prefix lookalikes
and unrelated dashboard/public-link routes use the original handler. Ops queue
and scheduled handlers, Client scheduled handling, and all named exports survive.

## Prepare and build, offline

`scripts/windows-files-staging-composition.mjs` is the pure constructor.
Its JSON input contains three **nonsecret** objects: `profile`, `preflight`, and
`sources` (the Operations and Client staging Wrangler configurations). The
profile has `schemaVersion:1`, an explicit boolean `enabled`, a reviewed gateway
`{origin,gatewayId,keyId}`, and the exact `secretSlots` metadata exported by the
module. No server key values belong in that input.

The builder pins account, Worker, D1, R2, private reader target, issuer and human
audiences to the existing staging inventory/preflight constants. Enabled
composition requires observed suffix-applied migration status, zero reported
foreign-key violations and the dedicated secret-slot names. It rejects a
production route/database/reader/audience, changed source main, unsafe gateway
URL, arbitrary key-slot names, and key values in plain vars. Matching hashes
prove input consistency; they are not signed approval, fresh physical-resource
proof, a canonical-history attestation or authorization to deploy.

```powershell
# PUBLIC_INPUTS_JSON is explicitly reviewed, nonsecret preparation data.
node scripts/windows-files-staging-composition-cli.mjs --write PUBLIC_INPUTS_JSON WORKSPACE_ROOT
node scripts/windows-files-staging-build.mjs --build WORKSPACE_ROOT
```

The CLI writes only new ignored paths in each app:
`.windows-files-staging/entrypoint.ts`, its preparation receipt, and
`wrangler.staging.windows-files.json`. Imports are fixed source paths; profile
metadata is compiled into the entry modules. Existing outputs are never
overwritten. Output failure leaves partial preparation visible for review.

The offline build verifies config/entry hashes, bundles both complete Worker
graphs with the installed esbuild, and compares their actual named-export
inventories with the original mains. Its ignored `module-build` output is a
static qualification artifact, not a deployed Worker or an assets upload.
No script runs Wrangler deployment, migrations, SSH, EH jobs or cloud mutations.

## Private configuration and runtime behavior

Only the existing secret-store bindings supply keys, encoded as canonical
unpadded base64url for exactly 32 bytes:

- Ops: `WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY`, `WINDOWS_EMPLOYEE_HANDLE_KEY`,
  `WINDOWS_EMPLOYEE_QUEUE_KEY` (three different keys).
- Client: `WINDOWS_PORTAL_QUEUE_KEY`, distinct from its existing current/previous
  delivery handle secret. No other Worker's secret is fetched to compare keys.

There is no arbitrary runtime origin, gateway ID, key ID or alternate-key slot
override. Missing, malformed or reused keys make only the claimed Windows
families unavailable. Original routes/background handlers do not require the
new keys. Nothing logs key material. Existing identity, authority, R2/version
and mandatory audit checks remain in the actual route factories.

Enabled generated Ops config explicitly enables the existing named reader's
`OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED` gate; Client config explicitly
enables its existing portal/native-read/content-audit flags. Disabled preparation
leaves every original flag unchanged. Named RPC methods execute with their own
Worker env; an HTTP profile does not bypass that env gate.

Cloudflare's current [Worker guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [secret bindings documentation](https://developers.cloudflare.com/workers/configuration/secrets/)
were reviewed. No module-level request state or router cache captures another
request's DB/keys. The existing app global Env declarations are unchanged; new
secret slots are limited to these isolated staging handlers.

## Acceptance scope and remaining live work

Local tests exercise the composers' actual HTTP factories, RS256 human checks,
empty authorized catalog/root discovery, closed route boundaries, unavailable
keys, fallback errors, and handler references. These unit fixtures simulate
identity/database state. A separate test invokes the real named reader class
methods with a platform base-class double, proving disabled/invalid admission
without SQL. That is **not Workerd cross-worker service-binding dispatch**.
Static bundles compare actual exports, including the private reader and every
existing workflow/RPC class. Full deployed identity, file transfer, audit and
revocation remain the live acceptance in `windows-files-staging-acceptance.md`.

The fresh read-only observation supplied on 2026-10-22 still reports Ops through
0221 and Client through 0234, both with zero FK violations. Thus the five Windows
suffix migrations remain pending; this source change applies none. Those schema
pages are non-atomic and canonical history remains unverified. Before an actual
EH-controlled activation, re-read the actual paired versions/bindings, reconcile
the exact migration window and reviewed gateway/TLS/root configuration, then
upload the reviewed candidate through the authorized staging process and verify
its resulting bindings/routes. This document does not authorize that step.

The earlier staging-host free-space figure was historical. The latest supplied
metadata reports about 8.89 GB local-root free; large fixture generation belongs
on the approved PC lab, not that host or a NAS mount.
