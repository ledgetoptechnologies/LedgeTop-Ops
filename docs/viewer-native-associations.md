# Native client project associations

These Operations endpoints link an already published, ready Viewer model to an
existing native client project. They do not publish processing outputs, create
clients, grant client access, or create public links. Viewer continues to own
models, versions, assets and processing.

Catalog reads and staff sessions require **global** `viewer.view`. Creating
or refreshing an association requires global `viewer.manage`.
Division-only permissions do not expose the global Viewer catalog. The normal
Operations human authentication and mutation-security middleware still applies.

## Read the available targets

`GET /api/viewer/native-associations` returns:

- `enabled`: integration availability.
- `projects`: native project targets with `sourceId`, `workspaceId`, `workspaceName`,
  `projectPublicId`, `projectId`, `projectName`, `clientName`, `generationId` and
  `sourceVersion`.
- `models`: the signed Viewer model catalog.
- `associations`: existing associations for current native project versions.

The native project and association lists each fail closed above 500 entries.
Only active native workspaces with a complete active generation and a matching
active, source-qualified Delivery project are targets. This read does not query
management-only client grants or require a legacy client account. Friendly names
are labels; use the returned identifiers without deriving IDs from labels.

## Create or refresh a model link

`POST /api/viewer/native-associations` requires a fresh `Idempotency-Key` and a
strict JSON object containing the six returned target fields:

```json
{
  "sourceId": "<returned sourceId>",
  "workspaceId": "<returned workspaceId>",
  "projectPublicId": "<returned projectPublicId>",
  "projectId": "<returned projectId>",
  "generationId": "<returned generationId>",
  "sourceVersion": "<returned sourceVersion>",
  "viewerModelId": "<returned model id>"
}
```

The server checks that the model is available, ready and has an active version.
The full target tuple must still match at selection and inside the atomic D1
association/receipt/revocation-outbox batch. A workspace revocation, source
reassignment, projection-generation change or version change aborts the entire
mutation. Refreshing an existing link advances its version and retains the
existing version-bound session-revocation outbox behavior. Same-key/same-request
replay does not advance it again; a changed request requires a new key.

On `409`, reload the target list and ask the operator to review the current
selection. Do not substitute another source, workspace or generation.

## Open an associated model as staff

`POST /api/viewer/native-associations/:associationId/session` takes exactly the
six target fields above, without `viewerModelId`, and an `Idempotency-Key`.
It resolves the association against that native target without falling back to
legacy PA IDs. Revoked, stale or mismatched targets are rejected. The target is
rechecked after issuing the Viewer grant before returning it to the browser.
The association version and Viewer model/resource versions must also remain
unchanged; a concurrent association refresh returns `409` without exposing the
superseded grant.

The grant authorization is capped at the earlier of 30 minutes and the current
verified Operations Access expiry. Missing or near-expiry (60 seconds or less)
Access authorization is rejected. The exact native target and Access expiry
participate in the session receipt fingerprint; a changed target or human
authorization cannot replay the previous receipt with the same key. Use a new
key for a new sign-in session or a newly reviewed target.

Existing legacy association/session endpoints and client authorization remain
unchanged. Native client model access still requires its separate, explicit
source/workspace/project or task grant and current portal authorization. The
association table remains project-scoped; a workspace-qualified staff request
does not create a workspace grant or persist an inferred workspace identity.
