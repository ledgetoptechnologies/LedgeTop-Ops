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

## Staff workflow

The staff UI is available only inside an already projected business-project workspace. The project currently open in the URL is always the destination; request bodies cannot redirect preview or commit to another destination. The source picker progressively reads existing projects from the same exact source and canonical client or organization root and excludes the open destination.

Staff explicitly choose contact roles and memory sections. The conflict policy begins at `keep_destination`; choosing `replace_source` is a deliberate radio selection and still never lets an empty source value clear a populated destination field. Preview performs fresh protected reads for both project revisions and overlay versions, then displays only bounded counts and conflicts. Commit remains disabled until the staff member confirms that preview. A transient commit retry reuses its idempotency key, while changes to source, selection, or policy invalidate the preview and operation key.

Authorization, missing-project, ownership, context, or stale-version responses clear the entire protected project workspace. Transient failures preserve the reviewed preview for a safe retry. Successful copy refreshes the operational contacts and memory shown for the destination.

## Explicit non-effects

Copy-forward never reads or writes delivery grants, portal access, billing, invitations, notifications, attachments, project lifecycle, or the Delivery database. It does not infer contacts from email, portal membership, billing recipients, or address-book labels. The UI describes this as copying selected operational details, never as project creation.
