# Outbound quote and pricing source ownership

Local implementation checkpoint, August 26, 2026. This is not a production
release or authorization to activate another Project Alpha instance. It follows
[delivery intent ownership](delivery-intent-source-ownership.md) and the
[multi-source design](multi-source-client-design.md).

## Destination and retry contract

The public quote and pricing paths still accept only server-proven primary
source authority. The scalar connector settings are not a fallback for unknown
or secondary sources. A caller-supplied source selector does not establish
authority. The authenticated connector registry and secondary activation remain
separate release gates.

Before a new quote command leaves Operations, migration
`0160_project_alpha_quote_destinations.sql` provides an immutable reservation
containing its request/revisions, source, exact command endpoint, application
key, editor origin, destination fingerprint, canonical payload/hash and
idempotency key. No bearer credential or signing secret is saved. Credentials
can rotate for the same destination; changing the source, endpoint, application
or payload cannot silently redirect an uncertain retry.

The reservation is read back before network I/O. Concurrent reservations must
agree on all frozen fields. A retry sends the same body and idempotency key to
the same destination. A timeout means the outcome is unknown, not that Alpha
definitely rejected the command. Remote idempotency remains part of the paired
Alpha contract; a local database cannot roll back a remote quote creation.

An unresolved command for another revision blocks creation of a newer command.
Both the capability read and reservation transaction enforce this: changing the
work area after a timeout is not permission to silently send a second quote key.
The UI explains that the original outcome needs reconciliation first.

Each new receipt must reference the exact source/request/revisions/key/hash of
its reservation. Receipt, request audit and Delivery audit commit in one local
D1 batch. If receipt persistence fails, retain the reservation and retry the
same command to reconcile; do not delete the journal, alter its payload, or
issue an unrelated new key as a recovery shortcut. Concurrent identical
receipts converge on the committed winner; differing results fail closed.
The losing request still rechecks its current authority before returning a
winner's receipt; a clean earlier receipt cannot override a later revocation.

Existing receipts predate destination recording. The migration preserves their
original bytes and timestamps, classifies their source as primary, and leaves
`command_id` null. It does not manufacture an origin from current configuration.
The UI shows their document number/public ID and explains that the original
Alpha instance must be opened manually. A legacy replay never creates a new
reservation or sends another command for that recorded revision.

New editor links use the saved origin and validated quote-specific path, even
when current configuration is disabled or changed. This is destination
provenance, not automatic permission to open Alpha; Alpha still authenticates
and authorizes the editor request.

## Current authority and stale responses

Operations rechecks global staff permission and source-owned business/request
references before sending and after receiving. It compares the current request
and canonical payload with the reserved scope. A confirmed remote result whose
local authority changed is retained as a stale receipt, with a matching audit,
and is not offered as an ordinary usable quote.

The final receipt SQL also checks current Delivery account/project ownership,
grant, active state, request/area revisions and scope. This protects the local
commit boundary. Operations business projection/ACL checks are separate reads
against OPS_DB: these safeguards do **not** claim cross-database or remote-Alpha
transactional atomicity. A subsequent revocation still requires normal
authority checks at each protected application boundary.

Pricing previews are transient planning guidance, not quotes, financial
snapshots or authorization grants. Their internal input now carries the stored
draft's catalog source and the authorized native workspace/project source.
Those fields are not inserted into the existing signed wire payload. The
resolver proves the exact stored draft ID/version, account, project, grant and
service-child provenance. After the upstream await, the route rechecks the
draft, resource permission and source before returning a hint. Unavailable or
changed authority produces the existing final-quote-after-review fallback.

Both transports use manual redirects and reject redirected responses without
forwarding credentials. They enforce a 16 KiB JSON response limit on streamed
bytes, reject malformed UTF-8, cancel unused bodies and bound the entire
fetch/body exchange (quote: eight seconds; pricing: four). Late responses are
discarded. Pricing validity is checked at completion, not merely at request
start. Neither path adds a cross-source cache.

## UI behavior

Quote capability comes from the server's current request/source proof. A failed
status read disables creation and offers a focused retry. Mutations refresh
capability rather than inventing enabled state. The request detail component
has a keyed lifetime, aborted superseded reads and immediate duplicate-click
protection, so a delayed response for one request cannot populate another.
Receipts display request/work-area revision and saved date.
Their explanation is vertically grouped with spacing, rather than squeezed
into several narrow columns inside the status notice.

## Release and recovery

1. Keep secondary ingress and client authority disabled. Resolve outstanding
   source/staff policy and producer prerequisites before any broader activation.
2. Back up and rehearse the entire pending migration chain with populated data.
   The new migration is additive; original receipt immutability remains intact.
3. Apply the paired schema and Operations/Client code in an approved release
   window. New receipt inserts require a reservation; old quote writers are not
   compatible with the migrated schema. Do not roll back only the application.
4. Verify primary quote create/replay, saved editor destination, historical
   receipt display, unavailable pricing and request navigation before reopening
   normal acceptance. Do not use live quotes or clients as disposable QA data.
5. On an uncertain command or destination conflict, reconcile against the
   original Alpha instance using the saved key and receipt. Never rebase old
   receipts onto a new host. A source-registry/admin reconciliation UI is not
   supplied by this increment.

No production migration, deployment, invitation, grant, configuration change or
mail was performed. Alpha's local public-ID export remains unpublished and its
rejected publication must not be retried without renewed approval. Viewer and
thumbnail runtimes are unchanged. The broader goal remains active.

## Verification

The following focused local gates passed, running one heavy runtime at a time:

- 13 populated full-chain migration cases cover reservation/receipt ownership,
  historical preservation, immutability and collision guards.
- 70 Client pricing-provider and service-request cases cover source proof,
  unchanged signed payloads, bounded transport and stale authority. The final
  provider-only rerun after a D1 session typing cleanup passes all 30 cases.
- 20 real-D1 Operations route cases cover command reservation, destination
  changes, uncertain retries, concurrent receipt convergence, revocation,
  unresolved prior revisions and transactional audit rollback. The fixture uses
  the complete Delivery migration chain and a minimal real OPS projection
  schema; staff ACL loading and external Alpha transport are mocked.
- 50 Operations transport/admin-route cases pass. An earlier combined run's
  one failure was a mock SQL matcher incorrectly treating the new unresolved
  command query as a receipt read; the corrected matcher passes the final run.
- 24 Operations desktop/mobile browser checks pass for quote actions and the
  existing request, work-area and attachment workflows. The quote-only rerun
  passes all 14 cases; a final two-case screenshot rerun also passes.
- Four Client desktop/mobile pricing workflow checks pass, including waiting
  for the superseded request to finish or fail before asserting that its older
  response cannot overwrite the current hint. An interrupted earlier fixture
  cleanup run is not counted as a pass.
- Operations and Client TypeScript checks and production builds pass. Existing
  large-bundle warnings remain. `git diff --check` passes.

Desktop and mobile full-page receipt screenshots were inspected: receipt text
is vertically grouped and readable. The inspection also found an unrelated
missing-coordinate `0,0` navigation defect and mobile overflow in that navigation
panel; both remain pre-release follow-ups in the roadmap. This is not a claim
that all request-page layout issues are resolved.

These are focused local gates, not a new full-monorepo run or live Alpha
acceptance. No production database or external client workflow was exercised.
