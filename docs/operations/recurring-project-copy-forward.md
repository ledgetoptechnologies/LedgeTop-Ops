# Recurring project copy-forward contract

This backend service copies selected LTDS Operations overlays from one already projected Project Alpha project to another. It does not create the next project. Project creation and lifecycle remain authoritative in Project Alpha.

## Safe initial scope

- Source and destination must be distinct, active projections from the same exact source and canonical client or organization root.
- A source may be in any lifecycle state. A destination must be `not_started`, `active`, or `overdue`.
- Callers explicitly select `project_contact` and/or `site_contact` roles and individual structured-memory sections.
- Destination-only values are preserved. Equal values are no-ops. Empty source values never clear destination values.
- Conflicts keep the destination by default. Replacing a conflict requires the explicit `replace_source` policy in both preview and commit.
- Contact copying requires `project.contacts.manage`; memory copying requires `project.memory.manage`; selecting both requires both permissions. Normal project visibility and client-directory access are also required.

Preview is a live, deterministic plan. Commit requires its fingerprint plus the exact context, source/destination project revisions, and both projects' contact and memory overlay versions. Commit rechecks the source, root, project ownership and lifecycle, permissions, overlay versions, and selected contact membership inside one atomic D1 batch. A race fails closed and leaves neither overlay changed.

Successful commits store an immutable, bounded receipt with opaque source/destination IDs, selected role and section names, revisions, counts, and the conflict policy. The receipt intentionally excludes names, channels, instructions, and memory text. Idempotency is scoped to the actor and rejects reuse for a different request.

## Explicit non-effects

Copy-forward never reads or writes delivery grants, portal access, billing, invitations, notifications, attachments, project lifecycle, or the Delivery database. It does not infer contacts from email, portal membership, billing recipients, or address-book labels. A future route and UI must preserve these properties and must not describe the preview as project creation.
