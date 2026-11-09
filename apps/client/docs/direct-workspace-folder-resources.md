# Direct workspace folder resources

This Client API exposes Operations-approved, project-free folder shares to the signed-in workspace. Ops remains the only share-management authority; the Client API has no create or revoke route.

## Endpoints

- `GET /api/client/direct-workspace-folders` returns `{ resourceMode: "direct_workspace_folders", items: [{ id, name, expiresAt }] }`. Each `id` is an encrypted, short-lived folder handle. The list contains only grants currently valid for the caller's active portal identity and workspace membership.
- `GET /api/client/direct-workspace-folders/{folderHandle}/files` returns the existing Client file-page shape: `{ files, folders, breadcrumbs, folderId, prefix, cursor }`. `prefix` is always empty; file, folder, cursor, preview, and download identifiers are opaque handles.
- `GET /api/client/direct-workspace-folders/files/{fileHandle}` returns `{ resourceMode, file }` using the Client file DTO.
- `GET|HEAD /api/client/direct-workspace-folders/preview?file={fileHandle}` streams supported media inline, including byte ranges.
- `GET|HEAD /api/client/direct-workspace-folders/download?file={fileHandle}` streams a file as an attachment, including byte ranges.

## Authority and UI contract

- Grant audience is all active members of the selected portal workspace. The Ops share dialog must say this clearly; a selected client record does not narrow a workspace-wide grant to that one person.
- Ops selects the recipient from its current client or organization profile directory and supplies the acknowledged publication authority for that profile. Client verifies the selected record is the current published root or a direct client child of the current organization root.
- The delivery folder is identified by its canonical Ops folder reference. It does not need a Client `portal_v2_folder_bindings` row, a `portal_primary_staff_bindings` receipt, or a Project Alpha folder association.
- A business project, Project Alpha project association, Client `client_folder_associations` row, or public link is not required.
- Raw R2 prefixes never leave Client server code. Encrypted handles contain only a relative path and authority/version coordinates; every list, metadata, preview, and download request rechecks identity, active portal membership, current Ops authority/publication, active grant and expiry, and the recipient's current directory membership.
- Missing or stale authority fails closed. A stale handle returns `404`; unavailable database/schema returns `503`. The API does not turn an authority failure into an empty successful listing.
- Grant creation revalidates the pinned publication, active workspace, and monotonic membership revision inside the same D1 transaction as the grant, mutation receipt, and audit row. Membership or identity changes bump the revision; an expired membership is also detected by the transactional active-member count. A stale pin aborts the entire batch and returns conflict, leaving no active grant or receipt behind.

The portal's unified Deliveries view can call these endpoints alongside existing project deliveries and render the returned items without introducing workspace or project selection.
