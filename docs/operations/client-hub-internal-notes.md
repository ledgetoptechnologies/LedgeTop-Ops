# Client Hub internal notes

Client Hub internal notes are private Operations memory attached to one exact
canonical Client Hub root. Their authority key is the full tuple
`(source_id, root_namespace, root_kind, root_id)`; a note from another Project
Alpha source, portal workspace, local account, organization, or standalone
client must never be returned or mutated through the selected workspace.

Notes are deliberately not Project Alpha data. Creating, editing, or deleting
one does not call a connector, mutate R2, grant portal or delivery access,
select notification recipients, or expose the note to a client. The Client Hub
labels this boundary directly as “Operations staff only.”

## Authority and mutation contract

- Reading requires the existing live `team.view` Client Hub authority.
- Creating, editing, and deleting additionally require the global
  `client.notes.manage` permission. Migration `0051` grants it only to the
  immutable owner and administrator roles by default.
- Every request resolves and re-verifies the live canonical Client Hub root.
  Deactivated, remapped, hidden, or cross-source roots fail closed.
- Every mutation requires `Idempotency-Key`. Repeating the exact request with
  the same key returns the stored outcome; reusing the key for another change
  returns `409`.
- Updates and deletes require the note's current `expectedVersion`. A stale
  version returns `409`; the UI preserves the draft and asks the operator to
  refresh before reapplying it.

“Delete” is an audited soft deletion. The note disappears from the active
workspace, while the immutable `created`, `updated`, and `deleted` revisions
remain. Database triggers prohibit revision, mutation-receipt, and hard-note
deletion. Do not add a purge job without a separately approved retention and
legal/audit policy.

## Rollout and verification

Apply Operations migration `0051_client_hub_internal_notes.sql` before the
Worker version that registers the note routes. Rollback the Worker if needed;
the additive tables may remain. Verify an organization and a standalone client
at desktop and narrow mobile widths, including create, edit, delete, stale
version, transient retry, permission removal, source isolation, and immutable
revision behavior. No feature flag, Project Alpha deployment, R2 migration, or
Viewer deployment is part of this slice.
