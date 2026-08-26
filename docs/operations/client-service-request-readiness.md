# Client service selection and request readiness

Status: implemented and verified locally, August 25, 2026; not published.
This increment is not a production deployment or completion of the client
workspace roadmap. No new migration, service assignment, or access grant is
introduced by this increment.

## Authority before the form

`GET /api/client/request-readiness` checks the selected workspace's standalone
request target. An optional exact `projectId` checks that project. The result is
an uncached UI hint, not an authorization token. Creating, saving, and submitting
a request still enforce their own current permissions.

New Request controls appear only after the relevant readiness result arrives.
Loading, error and retry states do not create a draft. An old form's delayed
autosave, submit or attachment continuation must not change the URL or start
another request after the user leaves that form or switches workspaces.

The check intersects active local account, identity and membership, the exact
project's active request grant, the member's own project grant when applicable,
and the selected workspace's current `request.create` capability. An account
manager is not implicitly a manager of another workspace and does not gain
standalone request authority from a project grant. Catalog visibility is not
request permission.

The response reports form mode (`catalog` or `legacy`), exact workspace and
target, `canStartRequest`, a bounded reason, root readiness, and
`projectRequestsSupported`. That last field means only that common prerequisites
are available. The UI must also find an authorized project in its scoped project
list and check the exact selected project before mounting its form.

Project-only clients choose an authorized target before a new draft can
autosave. Standalone is offered only when root readiness allows it. Saved drafts
retain their own target and service versions. Workspace/target changes must not
accept an earlier asynchronous response or silently move a draft.

`CLIENT_PORTAL_REQUEST_V2_ENABLED=false` selects the existing legacy form; it
does not disable otherwise-authorized requests. Missing legacy rate-limit
configuration, missing catalog/draft backend support, no published catalog, and
unavailable compatibility access each have an explicit unavailable state.
An unsupported native workspace without a current legacy bridge remains denied;
opening the form does not manufacture a bridge or grant.

The readiness helper is read-only. Existing login middleware retains ownership
of configured identity-eligibility provisioning; do not describe that entire
middleware stack as universally write-free. A proof changing during readiness
returns 409 and requires a fresh check.

Common authority reads are shared within each proof, not cached across proofs
or requests. Both proofs use fresh primary database sessions and the existing
deny/entitlement evaluators. More than 200 live rules for a capability still
fails closed. Invitation and eligibility bridges retain their existing priority;
a bridged member cannot fall back to a different manager identity when a project
grant is revoked. Older databases may omit the explicitly supported optional
bridge tables; only those exact missing-table errors use compatibility handling.
Other database errors must not become a successful readiness result.

## One source-owned library

The existing sanitized Project Alpha projection remains the source of service
IDs, versions, category labels, descriptions, questions, and geometry rules.
Categories are display labels, not a hierarchy or entitlement model. Operations
does not create a parallel service catalog or infer per-client assignments.

The service step starts with category cards. Search and browsing never remove
selections: chosen services and their saved answers remain in a separate visible
section. Explicitly adopting a newer service version clears only that service's
answers for review. Missing services are not silently replaced with their saved
snapshot in the published catalog.

The additive `/api/client/service-catalog/page` API uses bounded keyset pages and
the current projection checkpoint. A changed checkpoint invalidates continuation
with 409. The browser preserves selections, explains that the library changed,
and offers refresh. Search/category counts describe loaded services until the
terminal page; Load more is explicit. Missing selections must not be labelled
unpublished while more pages remain or a load failed.

The old `/service-catalog` response remains compatible. A legacy catalog without
an initialized projection checkpoint returns `503 catalog_not_ready` from the
paged endpoint. Only that typed response permits the UI to use the old bounded
list on an initial page load, visibly marked legacy/incomplete (up to 500 services). It must not treat
absence from that list as proof of unpublication. Authentication failures,
network errors, and other server errors must not trigger that fallback.

## Saved data and submission

If catalog/configuration readiness temporarily prevents editing, a successfully
authorized saved-draft read can still show a read-only summary and saved answers.
This does not apply to denied access, a wrong workspace/target, or an unavailable
project: old content must not reappear as a workaround for failed authorization.

The maximum remains ten distinct services. Each carries its public ID, reviewed
source version, sanitized question snapshot, and answers. Create, save and submit
now recheck every reviewed active version in the first write of the atomic
database batch. A concurrent unpublication/version change cannot leave a partial
draft, replace answer snapshots, submit a stale request, or queue its notice.
Existing optimistic versioning and idempotent replay semantics remain in force.

The authorized draft pricing-hint integration already exists and is preserved.
It is separate from catalog browsing: workspace/project authority, reviewed
versions, expiry and a non-binding disclaimer govern it. General administrative
prices are not exposed in the library, and this increment does not invent
fixed-price or per-client pricing rules.

## Acceptance and release boundaries

Verify real migrated-D1 permission intersections, deny precedence, missing
configuration, catalog races, current project-list/detail agreement, stale
asynchronous responses, legacy form compatibility, saved-draft resumption,
keyboard navigation, narrow/desktop/ultrawide layouts, and paged completeness.
Use synthetic local accounts and requests. Do not send invitations, actual
client notifications, or production requests as UI tests.

This is still the existing single-producer catalog contract. Multiple Alpha
producers, per-client service assignments, generic feedback, and the broader
client-workspace identity roadmap remain separate work. Viewer and thumbnail
code are unchanged. See [the roadmap](client-workspace-roadmap.md) and
[the portal contract](../client-portal-v2-architecture.md).

Local browser acceptance on August 25: all **138 Client Portal browser tests**
passed, including **34 new service-library/readiness cases**. The final production
build and TypeScript check passed. Layouts were visually reviewed at 375, 640,
1280 and 3440 pixels, including long service names, keyboard focus and preserved
answers. Existing synthetic active-share dates and saved-draft GET fixtures were
corrected; no Viewer runtime behavior was changed. The final serial Client
backend run passed **521 tests across 50 files**, with zero failures or skips,
in **471.67 seconds**. This includes all 32 readiness cases and the ten migrated-D1
end-to-end cases. These package checks do not supersede the known, separate
repository-level thumbnail documentation assertion or establish live acceptance.

The full-chain end-to-end test loader was also corrected to recognize SQL
triggers instead of maintaining a migration-filename whitelist. The old loader
split migration 0154 inside its trigger body and prevented that suite from
starting. The corrected loader applies ordinary migrations in per-migration
batches, retains the populated upgrade and foreign-key assertions, and explicitly
checks the notification tables and control trigger. Its focused ten-test run
passed without changing application code, migration SQL, or test timeouts. It
also passed within the final full run. No production migration, mail, invitation,
access change, push or deployment was performed for this increment.
