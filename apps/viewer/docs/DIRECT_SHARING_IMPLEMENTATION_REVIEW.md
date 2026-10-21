# Direct sharing: implementation contract and review

## Scope and privacy boundary

The workspace may present a ready output as **View / Share / Manage access**,
without a separate Review/Publish step. Internal publication is still the
verified visibility boundary. Import completion, opening Share, listing links,
and cancelling a dialog must never publish or grant access.

This change implements the backend for an explicit ready-output **Create public
link** action. It does not change Operations grants, create model associations,
publish every ready model automatically, or modify production data.

## Public-link API contract

`GET /api/v1/processing/outputs/:id/shares` requires `viewer.shares.read` and is
read-only. In addition to `shares`, it returns:

- `publicationRequired`: the output is ready but not the active published output.
- `existingAccessUpdateRequired`: activation may affect existing shared access.
- `eligibleAssetKinds`: server-verified public derivative kinds, not raw inputs,
  OBJ sources, reports, logs, archives, or arbitrary paths.

Ready eligibility requires the exact result model/version on its ready attempt,
the task's current active attempt, and an active parent project. Historical ready
attempts and archived/staged/failed/trashed outputs cannot be activated here.

`POST /api/v1/processing/outputs/:id/shares` retains the existing route and
requires `viewer.shares.create`, a live staff bearer session, and an
`Idempotency-Key`. Existing request fields remain supported: `label`, optional
`password`, optional `expiresAt`, `permissions`, and `displayUnits`.

Additional fields for ready outputs:

```json
{
  "publishIfReady": true,
  "allowExistingAccessUpdate": true,
  "selectedAssetKinds": ["glb", "tiles", "ept", "ortho", "dsm", "dtm", "shots"]
}
```

The example asset list is illustrative: send only returned eligible kinds or
omit `selectedAssetKinds` to choose the server's eligible public derivatives.
An explicit list must be nonempty and fully eligible. Invalid mesh provenance
never enables tiles; the verified GLB fallback can still be shared. Missing
hashes or a missing registered hierarchical entry file block activation.

- Ready outputs additionally require `viewer.processing.publish` and explicit
  `publishIfReady: true`; otherwise return 403 `permission_denied` or 409
  `publication_confirmation_required`.
- `allowExistingAccessUpdate: true` is required when replacing an active model
  version, when the model has live public links, or when its project has live
  project links. Otherwise return 409
  `existing_access_update_confirmation_required`. This covers a first model
  publication joining an already shared project's catalog, not just replacement.
- All consent flags must be booleans. A confirmation retry with a changed body
  needs a new idempotency key.
- Already-published outputs do not need publish permission and are not
  republished or reconfigured by these fields.
- Omitting a password creates a passwordless capability link. This means anyone
  possessing the link can use it; it is not an authenticated-client grant.
- Downloads default off. Passwords and expiry remain optional; view permission
  must be true. Existing measure/camera permission behavior is retained.

Response remains `201 { share, viewUrl }`. UI should make copying the returned
link explicit and offer existing revoke controls. Do not claim that an access
grant succeeded until the endpoint confirms success.

## Atomicity and repeat requests

`ProcessingRepository.publishAttemptAtomic()` retains its original API and now
delegates to `publishAttemptInTransaction()`. The latter requires an existing
transaction. This avoids nested `BEGIN IMMEDIATE` while letting explicit sharing
commit publication, selected published flags, model activation, attempt/task/
output state, link creation, both audits, and the success receipt together.

The endpoint requires ViewerRepository and ProcessingRepository to share the
same database connection. It rechecks authorization, output eligibility, expiry,
and exposure consent after asynchronous password hashing and inside the write
transaction. Any publication/link/audit/receipt failure rolls back the operation.

The committed receipt stores metadata, never the raw capability token or URL.
Existing deterministic token derivation reconstructs the same URL on replay.
A response lost after commit must not publish again or create a second link.

## Existing access and revocation caveats

Model links currently use **latest published version**, not a pinned output.
Activating a replacement can change what existing model links and associated
Operations clients can see. A project link dynamically includes current
published tasks, including future publications. The consent warning must explain
this; do not describe these links as isolated to one immutable output.

The existing routes remain:

- `DELETE /api/v1/processing/shares/:id`: staff link revocation, requires
  `viewer.shares.revoke` and idempotency.
- `POST/GET /api/v1/projects/:id/public-shares`: explicit whole-project scope.
- `DELETE /api/v1/project-shares/:id`: project-link revocation.

Public bootstrap and asset delivery check expiry/revocation and model scope.
Assets must remain published, registered, integrity checked, and served with
`Cache-Control: private, no-store`. Revocation blocks subsequent authorized
requests; it cannot retract photos/files already downloaded or rendered.

## Exact Operations client scope: required UI integration

`GET/POST/DELETE /api/v1/workspace/client-grants` requires
`viewer.client_grants.manage` and a valid `ops:` subject. It signs and forwards
list/create/revoke envelopes to Operations:
`POST /api/viewer/workspace/client-grants`. Browser credentials are not forwarded.
Operations owns clients, projects, model associations, grant validation, and
revocation; Viewer must not fabricate them.

For an individual output's Share action:

1. Match a returned Operations association to the selected model identity and
   intended Operations project/account using the actual authoritative response
   fields. Never match only a display name or assume the Viewer project UUID is
   an Operations project UUID.
2. Require `scopeType: "task"`, that exact `associationId`, and
   `includeFuturePublished: false`. Defaulting to the entire client project or
   selecting an unrelated association is not equivalent to sharing this model.
3. If no unique validated association exists, disable this action and explain
   that Operations association setup is required. Do not silently broaden scope.
4. Whole-project access and future publications must be separate explicit
   choices; neither should be preselected in the per-model flow.

The existing modal previously defaulted to project scope plus future published
tasks and listed all associations even when opened for one output. That behavior
must not be reused unmodified for direct per-model sharing.

**Missing integration authority:** this repository contains only the grant proxy;
it has no local endpoint that creates an Operations model association. A new
association workflow requires the Operations implementation/contract. No such
remote writes are part of this backend patch. Publishing and an Operations grant
are not one cross-service transaction; do not imply otherwise. Client-derived
public links also retain the existing signed source-authorization introspection,
fail-closed behavior, and at most five seconds of positive authorization caching.

## Regression contract

Focused backend coverage in `test/workspace-share-api.test.js` includes:

- Read-only preflight; no publication without explicit creation consent.
- Both permissions for ready outputs; share-only permission still works for an
  already published output.
- Passwordless/default-download behavior and exclusion of administrative assets.
- Invalid consent types, unavailable kinds, invalid tile provenance, missing
  hashes, and incomplete hierarchical manifest registration.
- Atomic rollback on publication audit, link insert, link audit, and receipt
  failure; original activation remains intact on rejection.
- Lost-response replay without duplicate links/publication or stored tokens;
  changed-payload idempotency conflict.
- Replacement and first-publication-under-project-link consent; expired/revoked
  project links do not force the live-link condition.
- Exposure appearing during password hashing and authorization revoked during
  hashing are checked before mutation.
- Historical ready attempts and archived projects stay blocked.

Integration suites: `processing-integrity-v16`, `output-access`,
`project-share-api`, `client-grant-proxy`, `source-authorization`, and
`published-session-source-revocation`. UI acceptance must additionally verify
open/cancel remains read-only, exact client scope, permission visibility,
confirmation/new-key retry, copy/revoke, and no standalone Publish UX requirement.

No production model or real Operations client has been mutated by this work.

### Local verification evidence

The six focused Linux suites passed **56/56 tests, zero skipped** using
`node:24-bookworm-slim`, a read-only source mount, no external network, and
`DATA_DIR=/tmp/viewer-test-data`:

```text
node --test --test-concurrency=1 test/workspace-share-api.test.js test/processing-integrity-v16.test.js test/client-grant-proxy.test.js test/output-access.test.js test/project-share-api.test.js test/source-authorization.test.js
```

The separate `published-session-source-revocation` test initially exceeded its
2.5-second startup window on a cold Windows bind mount. It now passes both in
the copied-source full Linux suite and in the exact final local runtime image.
The original source-route test required writable temporary `DATA_DIR`, since
the source mount itself is intentionally read-only.

### Workspace UI integration

The ready-model Share shortcut and Files action now use read-only preflight and
explicit **Create public link**. The old Review & publish action is removed;
isolated private viewing remains labeled **View**. Per-model Share does not
inject the whole-project public-link form. Public creation and clipboard copying
are separate actions, so clipboard denial cannot report creation failure or
trigger a second link. Same-form uncertain retries keep their original key and
consent payload even if background refresh observes the output as published.

Exact model association and Operations project/account matching drive the
per-model client form; missing/ambiguous/conflicting associations fail closed.
Private ready-client activation remains explicitly unavailable until its
Operations integration exists. Whole-project client access and future tasks
are unchecked, separate opt-ins. Whole-project public links require an unchecked
scope acknowledgment because their existing contract always follows future
publications.

Executed UI-handler, layout, dialog, and source-contract suites passed **61/61**:
`workspace-direct-sharing`, `workspace-task-layout`, `workspace-dialogs`,
`workspace-shell`, and `workspace-project-dashboard`. Handler tests run the
shipped functions with DOM/API doubles. In-app browser QA additionally verified
ready open/cancel remains read-only, explicit passwordless creation, downloads
off, mandatory whole-project consent, and cancelled/confirmed revocation using
synthetic data. New-link copy results are project/output/share-bound and clear
on matching revocation; stale revoked/expired results are not presented as new.
See `STORAGE_VIEWER_LOCAL_QA.md` for final image evidence and remaining live-data
and Operations integration limitations.
