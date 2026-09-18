# Project Alpha API v2 staging acceptance

This is an operator-only staging release check. It calls Project Alpha (PA)
directly; it is never mounted in an Operations Worker and is not a production
synchronization path.

## September 17, 2026 checkpoint

The current PA PR184 staging candidate is head `e260abeb`. It includes the
generic existing-application key-binding CLI, added after staging exposed a
separate application-identity conflict. SQLite is **15/64** and disposable
MySQL is **10/81**; PR smoke, CodeQL, Gitleaks, Docker publish workflow
`35283843624`, and Trivy are green. Staging was rebuilt healthy from exact
image `e260abe`. Unauthenticated capabilities returned JSON 401 with
`no-store` and no cookie; the web-log window had no errors or warnings.

Before live Project acceptance, create or rebind a temporary Project-only key
to shared application UUID `150cb108-af37-4973-ab6e-f6d991a6e8c8`. After the
live Project run, separately verify binding, refresh, lifecycle, and public-link
parity. PA `main` is not merged; this checkpoint does not claim production
activation and contains no secret or client data.

Run its default-off baseline without credentials:

```powershell
$env:PA_BASE_URL = 'https://pa-staging.example.test'
npm run staging:pa-api-v2:acceptance
```

Mutating mode requires `PA_ACCEPTANCE_ALLOW_MUTATIONS=allow`, a dedicated
non-`full` application API key in `PA_API_TOKEN`, and a prefix matching
`pa-acceptance-[a-z0-9][a-z0-9-]{2,60}` in `PA_ACCEPTANCE_PREFIX`. The key
must be bound to the supplied lowercase UUIDv4 identity headers:
`PA_SOURCE_INSTANCE_ID`, `PA_APPLICATION_ID`, and `PA_HISTORY_EPOCH`.
Cloudflare Access credentials, when required, are supplied only through
`PA_CF_ACCESS_CLIENT_ID` and `PA_CF_ACCESS_CLIENT_SECRET`. Never put a bearer
or Access credential in a fixture, command line, report, or repository.
An authenticated non-mutating capability check also requires those three
identity values so the runner can verify PA's returned identity and request ID.

## Canonical fixtures

All UUIDv4 values, PA public IDs, and SHA-256 values are lowercase canonical
hex: UUIDv4 is `8-4-4-4-12` with version `4` and RFC variant; public IDs are
32 lowercase hex characters; hashes are 64 lowercase hex characters. Member
order below is part of the canonical fixture format and must be retained.

`PA_ACCEPTANCE_PROJECT_PROFILE_JSON` is exactly:

```json
{"name":"pa-acceptance-example Project","description":"optional","estimatedStart":"2026-09-01","estimatedEnd":"2026-09-30"}
```

Every non-null profile value must be UTF-8 representable, control-free, and is
trimmed as PA trims it. `name` must remain nonempty, begin with the acceptance
prefix, and be at most 139 Unicode scalar values: the runner appends
` YYYY-MM-DD`, so PA's stored-name limit remains 150. `description` is at most
10,000 scalars; a trimmed empty description is sent as `null`. Dates are
either `null` or real UTC-calendar `YYYY-MM-DD` values, with start not later
than end.

`PA_ACCEPTANCE_ORGANIZATION_BINDING_JSON` (required) and
`PA_ACCEPTANCE_CLIENT_BINDING_JSON` (optional) are exactly:

```json
{"externalId":"pa-acceptance-example:organization","expectedPublicId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedRevision":"1","expectedProjectionSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
```

External IDs must be valid UTF-8 representable, control-free strings with
1–191 Unicode scalars and 1–764 UTF-8 bytes. Revisions are canonical positive
decimal strings no greater than `9223372036854775807`.

Optional project bind and refresh exercises use these exact member orders:

```json
{"externalId":"pa-acceptance-example:bound","expectedPublicId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedName":"Reviewed PA Project"}
```

```json
{"externalId":"pa-acceptance-example:bound","expectedPublicId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedPriorRevision":"1"}
```

Set those as `PA_ACCEPTANCE_BIND_COMMAND_JSON` and
`PA_ACCEPTANCE_REFRESH_COMMAND_JSON`, respectively. They identify a reviewed
target only: the runner requires the bind target's exact independently reviewed
name, then reads its live revision/hash, creates a new lowercase
UUID command ID, and carries forward the fresh authorization generation from
this run's create/update (and optional bind) response. It never sends a static
fixture command ID or generation. A refresh fixture's `expectedPriorRevision`
is the old active-binding revision captured before the out-of-band PA edit;
the runner fails closed unless the live revision is later than it.

For the no-delete archive/dark-restore rehearsal, set
`PA_ACCEPTANCE_ALLOW_LIFECYCLE=allow` and provide this exact ordered,
reviewed disposable fixture in `PA_ACCEPTANCE_LIFECYCLE_FIXTURE_JSON`:

```json
{"projectPublicId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedRevision":"1","expectedProjectionSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","expectedName":"pa-acceptance-example lifecycle","publicLinkUrl":"https://staging.example.test/projects/example","enabledStatus":200,"disabledStatus":404}
```

The runner verifies first execution, exact replay, and a changed-but-valid
same-command `409` for archive and restore. Before archive it requires that
the exact public ID, revision, projection hash, and name all match this
fixture. It never deletes the fixture.

When the same reviewed fixture has intentionally been made stale in the
application binding by the dual-editor conflict rehearsal, also set
`PA_ACCEPTANCE_LIFECYCLE_ONLY=allow`. This constrained mode requires the
lifecycle fixture and explicit lifecycle allow, rejects bind or refresh
commands, and returns before inventory, project creation, profile update, or
binding-status requests. It still fails closed unless capability discovery
advertises exactly the five base Project routes (create, read, write, binding
status, and inventory), archive, restore, and no others. This preserves the
stale-binding evidence while exercising archive/restore only on the exact
reviewed public ID, revision, projection hash, name, and public-link URL.

## Least-privilege scope and flag checklist

Give the dedicated application key `api.capabilities.read` plus only the
project scopes for the enabled harness paths:

| Current harness path | PA environment flag | Key scope | When required |
| --- | --- | --- | --- |
| `POST /api/v2/projects/commands` | `APP_API_V2_PROJECTS_CREATE_ENABLED` | `projects.create` | Always in mutable mode |
| `GET /api/v2/projects/{publicId}` | `APP_API_V2_PROJECTS_READ_ENABLED` | `projects.v2.read` | Always in mutable mode |
| `POST /api/v2/projects/profile/commands` | `APP_API_V2_PROJECTS_WRITE_ENABLED` | `projects.write` | Always in mutable mode |
| `GET /api/v2/projects/inventory` | `APP_API_V2_PROJECTS_INVENTORY_ENABLED` | `projects.inventory.read` | Always: before create and after update |
| `GET /api/v2/projects/bindings/status/{base64urlExternalId}` | `APP_API_V2_PROJECTS_BINDING_STATUS_ENABLED` | `projects.binding_status.read` | `PA_ACCEPTANCE_EXERCISE_STATUS=allow` |
| `POST /api/v2/projects/bindings/commands` | `APP_API_V2_PROJECTS_BINDING_ENABLED` | `projects.bind` | Bind fixture is supplied |
| `POST /api/v2/projects/bindings/revisions/commands` | `APP_API_V2_PROJECTS_BINDING_REFRESH_ENABLED` | `projects.binding.revision.refresh` | Refresh fixture is supplied |
| Archive and restore project commands | `APP_API_V2_PROJECTS_ARCHIVE_ENABLED`, `APP_API_V2_PROJECTS_RESTORE_ENABLED` | `projects.lifecycle.archive`, `projects.lifecycle.restore` | Lifecycle fixture and explicit lifecycle allow are supplied |

The required organization proof is an existing, active organization-directory
binding. Creating that prerequisite outside this runner needs PA's
`APP_API_V2_DIRECTORY_BINDING_ENABLED` flag and `directory.organizations.bind`; if a
client proof is supplied, its prerequisite uses that same flag and
`directory.clients.bind`. Those directory routes are not called by this
harness, so do not add either directory scope to its key solely for project
creation.

Optional client-directory coverage is only the optional client proof above;
it does not make client create/read/write, profile, relationship, lifecycle,
directory inventory/status, unbind, or any legacy/full scope required. The
harness also does not call PA project complete/cancel or directory profile,
relationship, archive, restore, refresh, or revoke routes. Leave their flags
off and their scopes absent unless a separately reviewed rehearsal needs them.

The sequence creates a prefix-owned Project, checks create and profile-update
exact replay plus changed-body conflict, checks the authoritative read payload
(ID, revision, hash, profile, and relations), then always validates binding
status when selected and paginates post-update inventory (up to 20 pages)
against the current identity and authorization generation until it finds the
created Project or reaches the real end. Mutable capability discovery must contain exactly
the selected routes and scopes (plus `GET /api/v2/capabilities` and
`api.capabilities.read`); any surplus advertised route or grant fails closed.
Reports contain only statuses, request IDs, permanent IDs, revisions,
generations, hashes, and presentation booleans. They exclude credentials and
profile bodies.
