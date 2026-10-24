# Direct Viewer delivery to clients

Viewer delivery does not require a Project Alpha business project. PA remains
the owner of quotes, contracts, invoices and financial records. Existing
association-based Viewer delivery and public links retain their contracts.

## Sharing scope

- Choose a current connected client, then an existing Viewer processing project.
- A project grant includes its current and future **published** tasks, with
  explicit confirmation. It never shares raw images, processing logs or drafts.
- A task grant permits exactly one published task in that Viewer project.
- Permissions and expiry are immutable. Revoke and create a replacement to change
  them. A duplicate active scope returns `duplicate_active_grant` and its grant ID.
- A client account grant applies to its currently authorized members. It does not
  create portal membership, PA project permissions, file grants or public links.

## Interfaces

Ops staff use `/api/viewer/direct-client-grants`; the Viewer admin shell uses
`/api/v1/workspace/direct-client-grants`, bridged by signed requests through the
existing Ops machine endpoint with `connection: "direct"`.

`GET` accepts bounded `q`, `cursor`, `limit`, and `viewerProjectId` queries and
returns `clients`, `clientsNextCursor`, and `grants`. The grants list is bounded;
filter by Viewer project when required. `POST` requires an `Idempotency-Key` and:

```json
{
  "sourceId": "project-alpha:primary",
  "workspaceId": "returned-client-id",
  "viewerProjectId": "returned-viewer-project-id",
  "scopeType": "task",
  "taskId": "returned-viewer-task-id",
  "includeFuturePublished": false,
  "confirmedScope": true,
  "permissions": { "measure": true, "cameras": false, "download": false },
  "expiresAt": null
}
```

For project scope, use `taskId: null` and `includeFuturePublished: true`.
`DELETE /:grantId` requires an idempotency key and a JSON reason. A `202` response
means local access is revoked but existing Viewer sessions are awaiting the
durable remote revocation. Repeating the request is safe; the existing cron also
retries pending revocations.

Clients read `/api/client/v2/workspaces/:workspaceId/viewer` and open a returned
task through `POST /api/client/v2/workspaces/:workspaceId/viewer/:grantId/tasks/:taskId/session`.
The session body accepts only display units, never identity or permissions.
Account selection remains internal to authorization; the unified UI can show one
flat list across authorized accounts. Deduplicate overlapping grants by account
and task, retaining one complete authorized row rather than combining permissions.

List cursors are opaque, expire after 15 minutes, and are bound to the verified
identity, account context and current grant set. Each request reads at most five
bounded upstream pages; an empty page can still carry a continuation cursor.
Session issuance rechecks client authority and exact task publication. Durable
issuance intents preserve the same authorization deadline after a lost response;
expired intents are retained for a further day before bounded cleanup.

## Compatibility and activation

Required storage changes are Client D1 migrations `0237` and `0238`, and Viewer
schema `40`. Viewer schema `40` transactionally preserves existing published
session rows, indexes, triggers and foreign keys while adding a distinct
`direct_client_grant` source type. A source tombstone is keyed by type, grant ID
and immutable version, so it cannot revoke unrelated model associations.

Before activation:

1. Re-read current Hub owner decisions and resolve the existing production
   release gates. Source tests do not authorize a production cutover.
2. Run joined synthetic browser acceptance: project plus future publication,
   exact task without siblings, two isolated recipients, expiry, denied/removed
   membership, duplicate grants and pending/completed revocation.
3. Apply the additive D1 migrations through the reviewed release process. Update
   both Viewer API and worker together through the owner's normal container
   process. Preserve storage, secrets, mounts, old links and grants.
4. Verify the signed catalog and exact typed revocation with the candidate Ops
   and Client versions before exposing the new UI.
5. Preserve exact browser asset paths and bytes served in the previous 48 hours,
   verify old and new bytes in the active namespace, and record actual cutover
   and earliest permissible pruning. Do not schedule automatic asset pruning.

Direct grant revocation stops new issuance immediately in Ops and becomes live
in existing Viewer sessions when the remote tombstone is acknowledged. Existing
membership/root-policy changes retain the bounded session authorization lifetime
(at most 30 minutes); they are separate from direct grant revocation.
