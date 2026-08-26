# Business projection source isolation

Status: locally implemented and verified, unpublished, August 26, 2026.
This is not a second-connection activation or a production migration run.
See [multi-source design](multi-source-client-design.md) for the remaining
registry, Delivery, portal ownership, and business-party linking boundaries.

## Identity and ingestion

Operations migration `0033_projection_sources.sql` adds producer provenance to
the business projection and its coordination state. Primary records retain
their exact existing IDs. Other sources receive immutable opaque local handles
through `pa_projection_record_ids`, keyed by source, record kind, and exact
external ID. Relational references use those handles; stored upstream payloads
remain unchanged. Reserving a missing parent reference does not create an active
business record or authorize access to it.

Calendar `source_id` continues to mean its referenced operation, task, contract,
or invoice. `projection_source_id` identifies the Alpha instance; the two are
not interchangeable. Airspace matches inherit their operation's producer.

Snapshot and webhook ingestion use the same mapping and source-qualified
fingerprints, versions, leases, receipts, reconciliation, health, and run state.
A missing-record sweep for one source cannot deactivate another source's rows.
Receipt archival removes only the exact source/event pairs successfully stored
in the archive, not every event sharing a producer-supplied event ID.

The source-aware functions are internal seams for a future authenticated source
registry. Existing scheduled sync and signed public webhook ingress remain
bound to `project-alpha:primary`. Request body fields or URL parameters do not
select an authority. Snapshot credentials are explicit per call, never taken
from another source as a fallback, and credentialed redirects are rejected.

## Authority and consumers

The existing primary source remains the only staff-role authority. Additional
business sources cannot change staff identities, divisions, roles, Access-group
membership, primary Delivery mappings, or portal grants. Secondary entitlement
events are rejected before mutation; snapshot ingestion ignores their entitlement
collection. This conservative policy does not resolve the pending decision on
future staff authority.

Operations migration `0034_client_hub_projection_sources.sql` extends business
directory roots to additional Alpha source namespaces. Business rows stay
source-labeled and independently addressable, even when names, emails, numeric
IDs, or public IDs match. Secondary business roots have no inferred portal
workspace or account bridge. Existing primary and local-delivery roots remain
compatible. Assignment-based access continues to use primary staff provenance;
additional business data does not create an assignment grant.

Until outbound routing is multi-source, provisioning and quote commands remain
primary-only and require primary provenance. Established native portal flows
may prove provenance through a complete selected primary portal generation and
an exact account bridge; this is not an authorization grant and does not replace
the caller's normal account, workspace, or resource checks. Ambiguous or missing
proof is unavailable, rather than guessed from a name or email.

## Release and rollback gates

Do not apply `0033` with old Operations or ops-sync code running: metadata conflict
keys change from global to source-qualified. Coordinate both consumers and their
scheduled/webhook writers. `0034` must accompany the corresponding directory
reader/index code. This document does not authorize production changes.

Before a separately approved release:

1. Verify the paired schema/code against a populated copy, including existing
   primary IDs, raw payloads, receipts, Job Briefs, SOP links, folder links, and
   source-local relationships. Check foreign keys after migration.
2. Complete type checks, snapshot/event replay and isolation tests, downstream
   authorization/provisioning tests, production builds, and directory/browser
   workflow checks. Record actual results, not merely planned coverage.
3. Preserve a recoverable database checkpoint and pause/drain the old writers
   during the coordinated cutover. Operations and Delivery are separate commit
   boundaries; no cross-database transaction is implied.
4. Keep secondary connections disabled. Verify the primary sync, event replay,
   directory, permissions, health, and existing portal deep links before allowing
   normal work to resume.
5. If rollback is necessary, use the paired checkpoint and compatible application
   versions. Do not run old metadata upserts against the new composite keys or
   drop source provenance to force compatibility.

No second-source credentials, staff grants, live invitations, production access
changes, Viewer changes, or thumbnail runtime changes are part of this increment.

## Remaining activation work

The subsequent [Delivery provenance increment](delivery-source-provenance.md)
adds source-owned account/project references and primary-compatible consumer
guards locally. Its verification and paired release gates are tracked there;
it does not activate secondary delivery. Native portal ownership, lifecycle,
and replay state still need end-to-end source isolation. A registry must bind configured
credentials, a stable verified producer identity, and allowed capabilities and
workspaces. Outbound requests must route to that owning connector. Explicit
business-party linking must change presentation without merging identities or
granting access. Until those gates pass, an isolated business projection is not
evidence that connecting a second live Alpha instance is safe.

## Local verification

Operations TypeScript passed. The full single-worker backend run executed 952
tests across 119 files: 933 passed and 19 failed because the older feedback test
fixture omitted `pa_projects.projection_source_id`. Its schema and explicit
insert columns were corrected without changing application code or weakening
assertions. The complete feedback file then passed all 21 cases, including a
new regression denying primary staff assignment authority over a secondary
source. The original full run is not represented as a clean pass; it took
1,209.25 seconds, and the corrected feedback rerun took 96.00 seconds.

Earlier focused gates passed 11 source-mapping/migration cases, 49 snapshot,
ordering, retention and visibility cases, and 148 consumer/activation cases.
These sets overlap the full package run; their counts are not additive.
The 10 notification tests sharing the corrected fixture also passed in 32.36
seconds. No application code changed after the full Operations run. The full
ops-sync suite passed all 34 tests across three files in 202.63 seconds, including
forged source context, exact event/lease collisions, primary-only ingress and
unchanged staff-authority behavior. Its TypeScript and Wrangler production
dry-run build passed; the dry run did not deploy a Worker.

Operations production build and final TypeScript check passed. The focused
desktop/mobile browser gate passed all 118 cases across directory, detail
pagination, access management, business projects/workspaces and current-view
folder counts. Desktop and 375-pixel mobile screenshots were visually reviewed
for count placement, source status, readable contacts/projects and responsive
spacing. These browser tests use synthetic local API responses, not live client
accounts. The complete browser suite and complete Client package were not rerun
for this increment.

No known failing case remains from these gates. The post-fixture full Operations
suite was not rerun; the original full run and both corrected-fixture runs are
reported separately above. Production migration, paired deployment, rollback
checkpoint and read-only live acceptance remain pending separate approval.
