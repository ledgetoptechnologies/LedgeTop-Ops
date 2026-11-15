# Private iOS business reader

This is a source implementation, not an enabled staging integration. The named
`IosPilotBusinessReadService` has an empty source-controlled origin allowlist.
No environment variable can populate it. The ordinary Ops HTTP router and its
permissions are unchanged. Merger owns composition, current resource review,
staging admission and deployment.

The edge business routing/DTO/gate implementation is composed from the exact
PR509 source `050a4c6cdf90d2c4f432a87fb6dc542159e1459f`, edge blob
`146d5f9b4e2098a55675ce801297b33ee40da587`. Only that edge module and its
boundary tests are reused; unrelated old environment types, config, host pins
and native files are not imported. The private service still has an empty
origin allowlist and no deployment binding is added. A local signed-assertion
edge-to-private-RPC test exercises the actual data path rather than a mocked
business binding alone; provider-backed admission remains separate.

## Boundary and data

The private `read` RPC accepts only a bounded JSON string with `url` and
`assertion`. It uses the existing RPC envelope reader, independently verifies
the human Access assertion for the separate pilot audience, and resolves the
current canonical staff binding and admission. Cookie, Origin and Authorization
headers are not accepted by the private handler. No supplied principal or
permission is trusted.

Only these GET paths are implemented:

- `/mobile-pilot/v1/business-roots?cursor=...`
- `/mobile-pilot/v1/business-roots/{organization|standalone_client}/{encodedRootId}/projects?cursor=...`

The proposed source contract is exactly `project-alpha:primary`, namespace
`business`, for the selected existing PA Stage One projection into the separate
Staging account. The primary name is a database-local runtime identity; it does
not select production or relabel existing records. This is not a grant, evidence
of source registration, completed projection, or permission to enable an origin.
The retired `project-alpha:staging` alias and secondary sources are refused.
Public edge, private operations, and private business origin allowlists remain
empty; replacement staging admission requires separate review and acceptance.
The existing primary visibility rule is preserved: its registry row cannot be
hidden by setting `read_visible=0`, and ingestion suspension does not hide
retained records. Staff/record ACLs and live-root checks still apply. No source
visibility or staff permission is changed by this contract update.
The planned upstream snapshot uses its existing legacy instance-scoped contract
and configured Ops application key; its legacy instance UUID must not be
substituted with an API-v2 source/history/application identity. The proposal's
optional API-v2 fields are not prerequisites for that legacy snapshot or invented
identity evidence. The snapshot credential stays in the server's secret keeper
and is never given to the mobile client.
Successful legacy snapshot ingestion alone does not make a classic root visible
through the current Client Hub helpers. Those helpers also require a configured,
matching API-v2 source/application/history identity and current directory inventory
observations, alongside the real classic projection and ordinary permissions.
Without that current identity, classic roots remain hidden; an empty result is
not proof that staging contains no business records. Use the supported inventory
and projection operators and verify a nonempty permitted root before activation;
do not fabricate observations or add a fallback to bypass these checks.
Each page
has at most 20 items. Root fields are sourceId, rootNamespace, kind,
clientHubRootId and name; project fields are id, origin, name, status, startDate
and endDate. Financial data, contact details, payload JSON, files and writes are
excluded. No full staff session or mutable-router fallback is available.

The implementation reuses Client Hub's directory permission and live source
mapping rules, exact detail context, project policy and ownership predicates,
and final context verification. Directory access does not grant project access.
Its outer cursor adds actor/admission, source, namespace, collection and selected
root binding to the underlying policy/source/context cursor. Cursors select a
page and are not credentials; every read reapplies current authority.

## Read revalidation

Client Hub spans OPS_DB and DELIVERY_DB. Those databases cannot share an atomic
snapshot. The existing context/source checks are retained. A request-local D1
barrier permits supported SELECT/WITH reads and the exact read-only
`PRAGMA table_info(identifier)` schema-discovery form (with an optional single-quoted identifier), records copied bindings and
successful row snapshots, and seals before response release. Raw, exec, run,
dump, untracked statements and mutation SQL fail closed. There is no retry after
an uncertain result and no last-seen write.

Identical reads within one request share a pending promise and an immutable
serialized result snapshot. Every caller receives a fresh decoded copy. Keys
include exact SQL, copied bindings, projection/method and a database-local
consistency scope; this is not a cross-request cache. A latched failure rejects
warm cache hits too. Each unique observation still participates in the final
replay, so caching never bypasses the current staff/data check.
Direct-primary and first-primary-session reads use separate memo namespaces;
unconstrained and bookmark session modes are not admitted by this barrier.

Each database is revalidated independently. DELIVERY is checked first; OPS
observed queries and the current staff/admission snapshot are verified together
in one original OPS session batch immediately before release. The final Access
deadline is checked again. Failed, changed, unsupported or oversize reads return
unavailable rather than a successful empty page. An authorized directory with
no matching business rows may legitimately produce an empty page; a revoked
source or exact hidden root remains denied. An unused DELIVERY lane validates without
issuing a fabricated query.

Limits are 256 observed query executions per database, 2 MiB aggregate retained
SQL/bindings/row-snapshot bytes, 64 KiB SQL, the existing 24,576-character RPC
input bound, a 1 MiB RPC output bound and 4,096-character mobile cursors. These
are bounds on retained captures, not a claim that total runtime memory is 2 MiB.
The final batch also counts trusted staff-prefix statements against its cap.
The barrier deliberately refuses unsupported SQL/APIs; a helper change may
require qualification before this reader can use it.

## Required deployment contract — presently unprovisioned

Use the adjacent JSON as a proposal checklist, not a runnable approval or a
credential file. Unknown fields remain null. Merger must verify actual resource
ownership and source/record and human-admission evidence before proposing a
reviewed-origin source change or adding a binding. Existing machine MCP grants
remain limited to their approved synthetic reads; they must not be expanded to
discover or select arbitrary records for this pilot.

Staging belongs to account `df3f376bae6ee621f50cf972ebcc9484`. The fresh iOS
owner readback identifies Ops database `a58ea102-f04d-417a-bfd1-b0654cfeb503`,
but metadata presence is not selected dataset, source eligibility, subject
admission or permission proof. Do not reuse old production-account pilot config,
retired host pins, historical synthetic record IDs or ordinary web cookies.

Acceptance still requires local full-schema signed-RPC/ACL/no-write tests,
independent source review, actual approved nonempty staging data, edge/runtime
Access and private-binding checks, native device reads, pagination, revocation
and expiry. Mocked boundary tests or an empty allowlist cannot establish these.

No production, provider, identity, key, schema, route or Access change is made by
this source. Main changes require a PR; Actions remain main-only. Any later
Ops/Client frontend release must retain actual previous-48-hour asset bytes and
paths. Merger retains release ownership.
