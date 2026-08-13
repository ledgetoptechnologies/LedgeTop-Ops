# Internal browser SOP library

The browser SOP library is an Operations-owned staff tool for reusable field guidance. It is not this repository's runbook documentation, a client-delivery feature, or a Project Alpha feature. Repository documents explain how engineers and operators run the platform; browser SOPs are authored and deliberately published by LTDS administrators for staff and pilots.

## Access and authority

- Every route uses the existing Operations Cloudflare Access session. There is no public, client-portal, delivery-share, or bearer-link route for SOP content.
- `sops.view` exposes only the current published revision. Draft and archived documents return `404` from staff routes.
- Global Operations administrators with `sops.manage` may use `/api/admin/sops/*` to create drafts, inspect history, save, publish, archive, and restore.
- Mutations retain the existing exact-origin and HMAC CSRF checks, create `audit_events`, validate strict request shapes and length limits, and require an `If-Match: "sop-N"` value matching `expectedVersion`. A stale write returns `409` with the current version/ETag and creates no revision or audit record.
- Project Alpha remains generic and read-only. SOP tables reference no Project Alpha source and SOP mutations never call or modify Project Alpha.

## Lifecycle and immutable revisions

Migration `0020_internal_sop_library.sql` adds `sop_documents`, immutable `sop_revisions`, and exact `operational_job_brief_sop_links`.

The document owns a stable unique slug, lifecycle status (`draft`, `published`, or `archived`), optimistic version, timestamps, actors, and pointers to its draft and published revisions. The nullable `acknowledgement_policy_json` field is reserved for a future acknowledgement capability; this release has no acknowledgement UI, gate, or completion record.

Every create, draft save, publish, archive, and restore inserts a new immutable revision with a monotonic number, author snapshot, Markdown, server-rendered HTML, table of contents, sanitizer version, and parent. Publishing creates a new published revision rather than marking a draft row. Editing a published document creates a separate draft while the old published revision remains visible. Restoring copies an old revision into a new draft; it never rewrites history. Documents and revisions cannot be deleted through the product, and database triggers reject revision update/delete and slug mutation.

Administrators author the same canonical Markdown through a Markdown-native rich-text editor with an optional source view. A local `.md` or `.markdown` file may be imported as strict UTF-8 text after a replacement confirmation when the editor is dirty. Import only replaces the unsaved browser value: it never writes, publishes, or bypasses the sanitized preview. The normal explicit draft-save and publish lifecycle remains required.

Archiving is the deliberate unpublish operation. It removes the SOP from the general staff library and prevents new job links without deleting revisions. Publishing a restored draft makes it visible again.

## Markdown and reference policy

`marked` provides a maintained GFM parser and `sanitize-html` provides the explicit allow-list sanitizer. They are direct Operations-only dependencies because the repository previously had no Markdown parser or sanitizer; their lockfile entries are part of this change. The same pure-JavaScript renderer runs for the browser preview and on the Worker, but only the Worker output is persisted or trusted.

The safe subset is headings, paragraphs, ordered/unordered/task lists, emphasis/deletion, fenced and inline code, blockquotes, tables, horizontal rules, safe HTTPS links, and images that point to the existing assignment-authorized job-brief attachment content route. Raw HTML is disabled before sanitization. The sanitizer removes scripts, styles and style attributes, event attributes, forms, SVG/MathML, iframes/objects/embeds, protocol-relative or credentialed URLs, control/backslash/traversal tricks, `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, and every remote image. External HTTPS anchors receive `noopener noreferrer nofollow`. Heading IDs are deterministic and collision-safe, and the stored TOC is derived from the sanitized output.

An allowed attachment URL is still only a reference: its existing handler reauthorizes the requesting user against the exact job on every request. SOP rows never contain R2 object keys, and generic delivery/client browsing retains its `_ltds` and private-path filters.

## Exact job links

Staff who already have scoped `operations.manage` access may replace the set of published SOP revisions linked to an operational job brief. The route first applies the existing Project Alpha projection/assignment visibility and job-brief authorization. New links must match each document's current published revision; the database repeats that rule in an insert trigger.

The job brief stores the exact revision snapshot in its immutable revision JSON and keeps foreign keys to the immutable SOP revision. Later SOP drafts or publications cannot silently change field guidance. An assigned pilot receives the linked sanitized revision only inside the existing authorized job-brief response. An unrelated pilot receives `404` before any linked SOP is resolved. Archiving a document blocks new links but preserves an already linked exact revision for that job; removing the link in a later brief version does not alter historical brief snapshots.

## Release sequence

1. Back up and verify Operations D1.
2. Apply `0017_operational_job_briefs.sql`, then `0020_internal_sop_library.sql`, in an isolated non-production environment.
3. Confirm `PRAGMA foreign_key_check` is empty and `PRAGMA integrity_check` is `ok`.
4. Deploy the Worker and Operations client bundle together only after the migration is present.
5. Smoke-test admin draft/preview/publish/history/restore/conflict and staff/pilot published and assigned-job reads on desktop and mobile. Confirm draft/archive/client/unrelated denial, print layout, audit events, and exact revision retention.
6. Record staging migration list/apply evidence before any separately approved production rollout.

This implementation does not itself deploy, migrate a remote database, send notifications, or access client files.
