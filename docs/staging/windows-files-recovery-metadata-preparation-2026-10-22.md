# Windows staging recovery metadata preparation

This is source preparation and local mocked validation only. No staging command
was executed for this change. No migration, restore, export, activation, new
credential, scheduler or runtime execution is added. The existing npm preflight
command remains unchanged and does not request recovery metadata.

The read-only preflight supports a separate explicit option:

```text
node scripts/windows-files-staging-preflight.mjs --read-only --recovery-metadata
```

This is an operator command for separately authorized read-only observation, not
an instruction to execute it now. It uses the existing installed Wrangler and
credential-safe runner, with the exact staging account
`846c924bf17bf4f3dd15c97a4c5d1d51`. After **both** current Worker deployments and
their resources, origins and Access identity parameters pass the existing checks,
it permits only these two additional command shapes (plus its owned config path):

```text
d1 time-travel info ltds-ops-staging --json
d1 time-travel info client-data-staging --json
```

The owned config fixes `OPS_DB` to `78b34173-b168-4e3d-9832-bb9d245cc6b8`
and `DELIVERY_DB` to `b6f653ab-9acd-4421-9ad0-207754b59aeb`. No caller-supplied
database, account, timestamp, bookmark, SQL or additional command option is
accepted. No restore/export route is implemented. Existing schema/ledger
observation still runs; this option adds no client-row queries.

[Wrangler's command documentation](https://developers.cloudflare.com/d1/wrangler-commands/#d1-time-travel-info)
defines `info` as a remote read; the
[bookmark API](https://developers.cloudflare.com/api/resources/d1/subresources/database/subresources/time_travel/methods/get_bookmark/)
uses GET and accepts D1 Read permission. Omitting the timestamp requests the
current bookmark. The installed Wrangler implementation was inspected locally to
confirm JSON emits the result object containing `bookmark`; no credential files
were read. The wrapper accepts only that field and the bounded lowercase-hex
bookmark format shown in the official response example. Unknown provider shapes
fail closed without copying raw provider output/errors into the receipt.

Each Worker receipt records the bookmark and local observation start/completion
times, with `restoreVerified: false` and `crossDatabaseAtomicSnapshot: false`.
These are sequential recovery references, **not a paired atomic snapshot**. They
do not establish a successful restore, a backup export, canonical migration
baseline, readiness, or authority to execute the Windows pilot. Current live
versions can change after observation; existing guards must be rerun before any
separately authorized activation.

[Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/)
describes automatic recovery history and limited bookmark retention. Retaining a
receipt does not extend provider retention. A future rollback decision needs
fresh incident-specific review of both databases, retained application versions,
side effects and consistency; this tool never performs that rollback.

Local command: `node --test scripts/windows-files-staging-preflight.test.mjs`.
Tests use injected synthetic JSON, not Cloudflare or real client records. They
cover default absence, explicit opt-in, exact commands, both-version guards,
malformed/missing/oversized provider results, sanitized failures, no fallback,
temporary-config cleanup and invalid CLI argument refusal before any runner.
