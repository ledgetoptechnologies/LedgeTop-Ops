# Separate-account native request preparation profile

`scripts/separate-staging-native-requests-profile.mjs` is a pure source builder
and validator for a minimal, closed Client and Operations config pair in the
separate Cloudflare **Staging** account (`df3f376bae6ee621f50cf972ebcc9484`).
It does not write files, call Cloudflare, activate a gate, or claim runtime
acceptance. The profile metadata deliberately says `runtimeReady: false` and
`runtimeAdmission: "not-admitted"`.

## Pinned identities

| Worker | Account D1 | Access application | Intended origin |
| --- | --- | --- | --- |
| `ledge-top-clients-staging` | `ledge-top-portal-staging` (`15d02028-8c52-40b2-9979-d67abf7d5bbf`) | `bba2498b-7576-4c4d-84e3-23a62d701778` | `https://ledge-top-clients-staging.ledge-top-staging.workers.dev` |
| `ledge-top-ops-staging` | `ledge-top-ops-staging` (`a58ea102-f04d-417a-bfd1-b0654cfeb503`) | `37c5049c-a787-49cf-ac43-ba4d340bee70` | `https://ledge-top-ops-staging.ledge-top-staging.workers.dev` |

Both configs use only account `df3f376bae6ee621f50cf972ebcc9484`. Their
account, Worker, D1, Access application and audience identities are fixed in the
builder. Access audience values and team domain are public configuration
metadata, not secrets. Do not change these constants to reuse production IDs.

## Closed preparation state

Every inquiry, recipient writer, authority dispatch, home, hierarchy, workspace
publication, finance, delivery and viewer gate in this profile is explicitly
`false`. The two request service paths and their parent authority/publication
RPCs are declared so a later reviewed transition can inspect the paired
contracts:

- Client to Operations: `OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES`,
  `OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT`, and
  `CLIENT_PORTAL_SERVICE_METADATA_READER`.
- Operations to Client: `OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY` and
  `OPERATIONS_PORTAL_WORKSPACE_PUBLICATION`.

Client inquiry and capability-writer gates are independent and both default to
`false`; enrollment and its CSRF-protected confirmation route also remain
closed. The Client config includes the existing enrollment RPC binding because
that route requires it when separately admitted. Its expected host and the
reviewed CSRF secret name are explicit; the profile contains no secret value.

The Client D1 binding targets only the separate Staging portal database. The
Operations D1 binding targets only the separate Staging Operations database.
No production or legacy staging database, R2 bucket, queue, workflow, cron,
mail binding, or custom route is included. The `ASSETS` declaration supports
local application builds; it does not enable public access.

Each Worker config has `workers_dev: false`, `preview_urls: false`, and an empty
`routes` list. The workers.dev URLs above are intended origin metadata for a
future separately reviewed Access exposure. They do not resolve to an exposed
Worker while this config remains closed. Do not describe this pair as a
browser-ready test deployment or turn on workers.dev as part of source prep.
Merger must separately review Access policy, public origin exposure, runtime
host admission, schemas, exact D1 readbacks, synthetic identity, and paired
authority receipts before any runtime acceptance.

## Variable and secret accounting

The builder accepts secret **names only**. The minimal allowlists are
`CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_CSRF_SECRET` for Client and
`OPERATIONS_SESSION_SECRET` for Operations. Values are never accepted or
returned. It rejects duplicate or extra names, collisions between a secret
name and a text variable, any config drift, and a combined count above 64 for
either Worker. The total is computed separately for each Worker as text vars
plus secret-name metadata; Cloudflare's Free limit is 64 combined text and
secret variables per Worker.

This is a source-profile budget, not proof that the listed secrets exist in the
Staging account or that the installed Workers plan is Free. Secret presence,
plan and any later runtime readback remain external admission facts.

## Use and limits

Import `buildSeparateStagingNativeRequestsProfile()` to construct the prepared
pair, and pass the result to
`validateSeparateStagingNativeRequestsProfile(profile)` after any in-memory
transport. The module has no CLI, filesystem writes, secret-value parameters,
provider calls or activation helper. The pure tests cover fixed resource
identity, closed gates, exact service bindings, secret-name handling, budget
enforcement and the distinction between intended origins and enabled exposure.

This artifact prepares reviewed source metadata only. It does not authorize
migrations, deployment, Access exposure, live data reads, recipient grants,
inquiry writes, notifications, or production release.
