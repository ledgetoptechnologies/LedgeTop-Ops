# Independent staging machine reads

This code adds a separate machine boundary at
`https://ops-staging.ledgetopdroneservices.com/api/agent/v1/*`.
It is disabled unless `ENVIRONMENT=staging`, `OPS_AGENT_READ_ENABLED=true` and a
separate `OPS_AGENT_READ_AUD` are configured. The audience must differ from
`OPERATIONS_AUD`. Production hosts and environments return404. Installing0219
creates empty authority/audit tables; it admits nobody and creates no credentials.

The existing human MCP at `apps/operations-mcp/src/cli.mjs` is unchanged. The
independent entrypoint is `apps/operations-mcp/src/machine-cli.mjs`. Only
`get_connection`, `find_clients` and `get_client` are implemented. The remaining
six human read tools, previews, files, access rosters, grants, finance, onboarding,
mutations and general staff routes are unavailable to this transport. This is an
incremental read surface, not unattended parity with the nine human read tools.

`get_connection` includes `sources: [{sourceId, displayName}]` for tool-driven
source discovery without repository instructions. Candidate sources come only
from the caller's active grants. Each requires the same exact source/observer
checks and current native record policy as a lookup, with at least one readable
record. The selection, record witness and connector label are checked again
after the mandatory audit. Display names are bounded labels from the exact
matched connector, not authority. An empty list is not permission to guess an
alias or change identity. No additional tool, scope or credential is introduced.

## Authentication and authority

Cloudflare must later provide a more-specific Access application for only the
machine path, with an explicit Service Auth policy accepting each reviewed token.
Do not add Service Auth to the general human application, share its audience,
enable a broad bypass, or change organization-wide strict authentication settings.
The Worker verifies RS256, exact issuer and single audience, expiry/issuance,
`type=app`, empty `sub` and `common_name` equal to a registered service Client ID.
Human email claims are rejected. `service_token_id` and `service_token_status`
belong to get-identity and are not required JWT fields. See Cloudflare's
[application token contract](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).

Each machine has its own durable principal, owner, immutable verified Client ID,
expiry, version and revocation state. A revoked principal cannot be restored;
issue a new reviewed principal instead. Its owner must remain active in staff,
native profiles and native admissions, at the exact admitted subject/version
recorded during provisioning. Re-admitting an owner does not resurrect old machine
delegations. No machine is converted to a `StaffPrincipal` or `NativeStaffIdentity`.

Machine source/resource grants further restrict the owner's CURRENT native
`directory.profile.view` grants. Owner roles or admission alone grant no data.
Resource, assignment, business-area and division scopes are evaluated against
current native records; matching denies win. Missing/inactive classification
retains relevant scoped owner denies. Source-wide machine denies override allows.
Every data lookup requires one unambiguous current mapping and exact source,
origin, instance, application and history epoch. Directory source IDs and
projection aliases are recorded separately; they are never inferred from labels.
The connector at the explicit projection alias must exist, have `read_visible=1`
and match the selected origin. An absent row is not an implicit allow; a visible
directory alias cannot override a hidden projection alias.

Each data request authenticates a fresh capabilities call through the dedicated
`PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS` observer for its explicit
projection alias. The returned scope must be ONLY `api.capabilities.read`.
Directory/finance credentials are never used for this network call. Missing,
revoked, overprivileged or unavailable observers deny data. The current verified
source head must match the same tuple. Old local heads alone cannot authorize a
read. Owner/principal state is rechecked after the network await; the full SQL
data/policy selection is repeated after mandatory audit persistence. Changed
rows, grants, identity heads or versions fail closed. Authorization is a current
observation; no request can promise protection from a future revocation after
its final successful check.

Requests are fixed GETs, limited to 25 records and bounded source-specific cursors,
100-character searches, an atomic 60 requests per fixed UTC minute, bounded
profiles/responses and existing bounded PA probes. The final data query uses the
primary session. Audits contain only event ID, correlated server request ID,
agent/owner IDs, action, outcome and timestamp. A failed final authorization check
appends a denial to the same request; an earlier allowed check is not a delivery
confirmation. They omit search terms, profiles, credentials and raw JWTs.
Audit failure prevents data release. Invalid signatures/unregistered callers
have no trusted agent identity and cannot append attributed agent audit records.
Rate reservations/audits are the only local writes. No business, delivery or
financial state is changed. Audit/rate history is durable; a separately reviewed
retention policy is required before sustained high-volume use.

## Local operator schema contract (held; no credential creation included)

Provisioning is a separate reviewed operator action after code, migration and
policy tests. The current increment supplies no public credential issuance,
principal administration, SQL execution or revocation API. Do not let a machine
provision itself. Before later provisioning, capture the active owner's exact
`native_staff_admissions.bound_access_subject` and `version`, active profile and
current native read grants; choose a bounded expiry. Record a distinct Access
service Client ID for each agent/machine. Token secrets never enter Ops D1.

Within one reviewed operator transaction:

1. Insert `ops_agent_principals` with a fresh ID, the exact service Client ID,
   owner staff ID, exact owner subject/admission version, `status=active`,
   `version=1`, and integer Unix-second `expires_at`. No email matching or role
   expansion is performed.
2. Insert explicit `ops_agent_read_grants` rows with fresh IDs and the exact
   directory source, projection alias, origin, instance/app/epoch, effect and
   `scope_kind=source` or one existing `record_id` for `scope_kind=resource`.
   All selected tuples must match deployment configuration, live capability-only
   observations and current heads. There is no wildcard or cross-source fallback.
3. Read back the exact rows and run connection then source-qualified lookup/detail
   acceptance. Verify unrelated sources and records are denied.

To revoke, use an explicit version-fenced operator update, e.g.
`UPDATE ops_agent_principals SET status='revoked',version=version+1 WHERE id=? AND version=? AND status='active'`.
Require exactly one changed row and read back the revoked state. Grant revocation
similarly sets `active=0,version=version+1` at its exact current version. Registry
triggers prevent changing grant identity/authority or restoring a revoked row.
Rotate Access secrets through supported Cloudflare controls later; deleting a
local file alone does not revoke server authority. Server revocation takes effect
on the next check even for an otherwise unexpired Access JWT.

## Local agent setup after reviewed provisioning

Create a regular private credential JSON file outside the repository:
`{"clientId":"<reviewed ID>","clientSecret":"<secret>"}`.
Use owner-only permissions (on Windows, owner plus SYSTEM ACL); POSIX group/other
permissions and symlink files are rejected by the transport. The trusted local
configuration points `LTDS_MCP_MACHINE_CREDENTIAL_FILE` at this absolute path.
Never put the secret in tool arguments, chat, process arguments or a source file.
Current `cfast_` and older secrets are supported without an obsolete secret regex.

Configure a separate local stdio MCP entry with absolute Node and
`apps/operations-mcp/src/machine-cli.mjs` paths. The transport reloads the private
credential file per call, sends Service Auth headers on every request, follows no
redirects, accepts JSON only, and has a20-second/1MiB response limit. There is no
browser login, cached human cookie, automatic write flag, arbitrary URL or method.
`node <absolute-machine-cli> doctor` performs only the connection request.
Cloudflare's [service-token authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
supports noninteractive requests and secret rotation; its bounded expiry still
requires explicit operator renewal. No agent receives Cloudflare management or
PA command credentials.

Local tests establish code contracts only. Provider provisioning, signed live
service-token corpus verification, immediate revoke/rotation acceptance and
negative normal-human-route tests remain required before deployment/enablement.
