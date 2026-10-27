# Windows pilot app release feed (source-only)

This implementation adds a staging-only, authenticated Windows EXE metadata and
download path for the Operations app and Client Portal. It is a source contract,
not an artifact publication or release activation. The new control, catalog,
head, history, withdrawal, and pilot-eligibility tables are empty by default.
Both catalogs stay disabled until explicitly reviewed rows exist. No production
binding, artifact, cohort entry, grant, migration application, or release was
created by this work.

## Routes and compatibility

The native request is exactly
`GET /api/app/latest?platform=windows&channel=pilot&schemaVersion=1` or
`GET /api/client/app/latest?platform=windows&channel=pilot&schemaVersion=1`.
It returns the flat schema consumed by the Windows helper contract, or exactly
`{"schemaVersion":1,"available":false}` for an authorized user with no eligible
offer. Unknown/duplicate query keys and noncanonical values are rejected. The
older browser request with only `platform=windows` keeps its existing response
shape. Legacy platform-only requests for macOS and Linux return
`{"available":false}` rather than receiving a Windows binary. Both forms and all
download/HEAD/range requests use private no-store responses. Non-staging
environments and noncanonical origins do not serve the new path.

The metadata includes a canonical four-component unsigned-16-bit version,
length, lowercase SHA-256, strong ETag, source commit and EXE type. Its download
URL is a relative path under the selected service base. Download requests accept
no query or the exact ordered `platform=windows&channel=pilot` query. A browser
full `GET` or `HEAD` may omit `If-Match`; when supplied, it must be the exact
strong catalog ETag. The native consumer sends `If-Match` on every byte request.
Any Range request requires both exact `If-Match` and matching `If-Range`; missing
validators fail with 428, and stale validators fail with 412 rather than falling
back to a full body. Single byte ranges use ordinary 206 and `Content-Range`
semantics, with R2 length, range, ETag and stored SHA-256 checked against the
immutable catalog. Client eligibility is rechecked before bytes are read. Ops
checks current owner status and explicit pilot eligibility on each request and
before returning a byte stream.

## Storage and authority

The feed reads only the optional dedicated `APP_RELEASE_BUCKET` binding. It does
not use the general content bucket or its `_apps` namespace. This work adds no
Wrangler binding/configuration; missing storage fails as unavailable after a
user is otherwise eligible. The immutable catalog selects the complete R2 key;
callers cannot supply a key. The selected object must match the catalog size,
strong ETag, R2 SHA-256 checksum and the `appReleaseVersion`, `sourceCommit`,
`installerType`, and `sha256` custom metadata. A missing or mismatched object
does not produce an offer.

Operations access requires the existing verified human staff principal to be a
current global owner plus a separate exact pilot eligibility entry. Client
access requires the existing verified portal principal, current identity and
workspace membership, and a separate pilot entry tied to a current authorized
delivery recipient grant and folder scope. Neither path derives eligibility
from email, membership alone, public shares or machine credentials. The Worker
continues to use its normal Cloudflare Access assertion authentication path;
the desktop's Access token is expected to be authenticated at the edge.

Operations uses migration `0230_app_release_pilot.sql`; the preceding `0229`
slot is retained for the separately owned GSC work. Client Portal uses
`0241_app_release_pilot.sql`. The tables have no seed rows. The catalogs and
eligibility/revocation histories are immutable, and the head may advance only
to a newer version.

## Verification and readiness

Miniflare tests exercise Operations metadata and browser compatibility, default
off behavior, owner and revocation checks, staging and query gates, exact byte
and range delivery, required preconditions, and artifact mismatch rejection.
Client Portal coverage exercises the actual joined portal router with its
existing identity/workspace fixtures and verifies exact default-off metadata
and strict query rejection. Both application TypeScript checks pass locally.

These checks do not prove Cloudflare Access application coverage for the new
routes, live R2 configuration, a production migration, signed installer
qualification, hosted release behavior, or pilot readiness. Those remain
separate acceptance requirements. All published pilot artifacts must be
retained; this implementation includes no pruning path.
