# Contextual SOP links

LTDS Operations can pin an exact published SOP revision directly to a
Project Alpha-projected Project or Task. The resulting **Quick SOPs** chips are
visible on that Project or Task card, so assigned staff can open the procedure
without searching the library.

The relationship is deliberately direct. A Project link does not appear on its
Tasks or Operations, a Task link does not appear on its Project or Operation,
and no link is attached to a staff/person record. Operation job briefs continue
to use their independent link set.

## Data and lifecycle

Migration `0023_project_task_sop_links.sql` adds versioned Project/Task link
sets and immutable link rows. New links may reference only the SOP document's
current published revision. The pinned revision ID never advances when another
revision is published.

Archiving an SOP does not delete an existing link. The chip remains readable,
is marked archived, and opens that exact formerly published revision. Staff can
explicitly remove it from the work context. Deactivating a projected Project or
Task hides the entire context without deleting its LTDS-local link history.

## Authorization

- Project reads require visible `projects.view` scope plus `sops.view` for that
  resource context. Project changes additionally require scoped
  `operations.manage`.
- Task reads require visible `tasks.view` scope plus `sops.view` for that
  resource context. Task changes additionally require scoped `tasks.update`.
- A denied or unrelated target returns not found before link data is read.
- Exact historical/archived revision URLs carry the Project/Task context and
  reauthorize both the active link row and current target visibility on every
  read. A removed link immediately makes that revision URL unavailable; there
  is no global historical-revision endpoint.
- List APIs expose summaries only: title, purpose, immutable revision number,
  publication/archive state, and the exact reader path. Markdown, rendered
  HTML, and TOCs are loaded only from the authenticated SOP revision reader.

All replacements use `expectedVersion`. A stale editor receives `409` and must
reload instead of overwriting another staff member's change. Successful changes
write an Operations audit event with the context kind, context ID, new version,
and revision IDs.

## Project Alpha boundary

Project Alpha remains authoritative for Project and Task identity, lifecycle,
assignment, and scheduling. The projection must keep opaque Project/Task IDs
stable for their lifetime. LTDS owns only the contextual link set; Project Alpha
does not receive SOP content or attachment state.
