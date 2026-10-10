# PA-first Project adoption gap — 2026-10-09

This is a read-only source-review conclusion. It does not authorize a staging or production change, expose a credential, or claim live acceptance.

## Implementation follow-up

- The original analysis below records the gaps as found, not the current completion state.
- Gap 1 is fixed locally in commit `597f5e9a`. The full real-D1 producer suite passed 57/57, including a truly absent destination, exact/conflicting/racing destinations, atomic rollback, lost-response recovery, and current-authority checks on concurrent winner replay. Remote responses in that suite are synthetic; live PA acceptance remains required.
- Gap 2 now has a local default-off coordinator and private route at `/projects/adoption/finalize`, accepting only the saved reservation and command UUIDs. The server derives connection coordinates, requires the original authenticated reviewer and current owner/permission/customer-link checks, and composes existing dispatch, canonical GET settlement and activation ledgers. It does not open command-recovery authority or automatically resend an uncertain remote write.
- The UI keeps finalization separate from destination review, intent reservation and queued bind planning. It retains the same IDs on ambiguous outcomes and does not report activation until the final activation stage confirms success. Headless desktop/mobile tests pass, but their mocked responses are not database or live acceptance evidence.
- Current fast route/coordinator/UI/import-boundary regression run: 49/49 passed. The full-schema coordinator suite additionally passed 2/2: real D1 dispatch/settlement/activation composition with synthetic PA transport, scope-drift denial, exact activated replay without transport, and persisted acknowledgement followed by a failed canonical GET and successful retry without another POST. It checks exact project identity/name and unchanged row snapshots for eight portal/public-control tables. This proves local composition, not live PA acceptance.
- The UI now keeps recovery references visible after uncertainty and successful finalization, without storing credentials or adding authority. Headless desktop/mobile regression tests passed 2/2 after that change; build and Operations typecheck passed.
- A separate exact-delta finalization staging profile preserves the generic five-gate API-v2 parent and enables only finalization above it. Both tracked staging and production baselines require the new finalization gate to remain string `false`. The initial Viewer-parent version passed 31 local profile tests but fresh staging comparison showed that parent would unnecessarily change Viewer settings. The corrected PA-only profile plus unchanged API-v2/Viewer regressions passed 20/20 and has no Viewer secret-inventory dependency. No existing acceptance profile was widened. The stale ignored candidate was preserved privately before controlled regeneration/check; it must not be deployed.
- No production change, portal grant, client activation or public-link change is part of these fixes. The later canonical-ID candidate `4f277bd696e1fc03ed9e3817c92f21bd3b51208c` includes them and is active in Ops staging as version `8bf8b9e0-76d7-430b-9952-649e56d90b45`. Exact-revision CI run `38006336619` passed all ten jobs. Independent provider readback at `2026-10-10T00:18:52.165Z` verified this version at 100%, the reviewed acceptance gates, and complete binding/runtime configuration equality. Live authenticated PA-first adoption remains unproved; deployment and CI are not remote acknowledgment.

## Current normal-UI acceptance path

Use `/administration#project-alpha-connections` with a current authenticated native operator and the exact scoped synthetic authority. Do not substitute the legacy full-sync button or internal delivery-intent ingress routes for this flow.

- Discover: `GET /api/admin/project-alpha/private/projects/adoption/candidates` for the configured staging source. Require an observed candidate matching the independently verified synthetic PA project, not a name-based match.
- Review: `POST /api/admin/project-alpha/private/projects/adoption/review` with a fresh UUID idempotency key and the exact source/external/public project coordinates. The UI separately confirms the unused Ops project ID. Require `reviewed` and retain `reviewItemId`.
- Reserve: `POST /api/admin/project-alpha/private/projects/adoption/reserve` with the saved review ID and a frozen reservation idempotency key. Require `reserved` and retain `reservationId`.
- Plan binding: `POST /api/admin/project-alpha/private/projects/adoption/bind` with that reservation ID as both body coordinate and idempotency key. Require `planned` and retain `commandId`. This is a queued command, not acknowledged sync.
- Finalize: `POST /api/admin/project-alpha/private/projects/adoption/finalize` with the saved reservation/command IDs and command ID as idempotency key. Require `stage=activate` and `outcome.status=activated`, then independently verify normal bound inventory/canonical readback, exact one-to-one identity and shared name.
- Replays must reuse the exact saved coordinates. Conflicting bodies must fail without creating a second mapping or command. An uncertain write requires durable receipt reconciliation, not a replacement command.
- Independently verify unchanged portal/public-control rows and close the exact temporary authority. This adoption flow does not enroll a recipient or publish client data.

## Decision

Do **not** widen normal Project inventory to include unbound Project Alpha projects. The normal inventory contract intentionally enumerates application-bound projects. PA-first creation is served by the separate, generic, default-off adoption-candidate API and an explicit owner-reviewed adoption flow.

The synthetic staging project (PA local ID `8`, public ID `86099fc2948b9c9d2ed8b53cb587b3f0`, organization ID `10`) is therefore expected to be absent from normal inventory before binding. No implementation should special-case those identifiers.

### Fresh application-mediated staging fixture readback

- Read-only SSH used `migration_connection()` inside the pinned staging web container, using its normal configured database connection without extracting or printing credentials.
- Exactly one project matched local ID `8` and the expected public ID: revision `1`, organization `10`, status `not_started`. The organization exists and is neither archived nor deleted.
- Matching `api_v2_project_external_bindings` and `api_v2_project_command_receipts` counts are both zero. The project remains an unbound adoption fixture, not an acknowledged Ops mapping.
- `public_project_enabled=0`. The project has zero `portal_project_entitlements` rows, zero matching `portal_projection_resource_state` rows, and the staging projection outbox count was zero at observation.
- `portal_publish_enabled=1` must not be interpreted as a publication receipt or access grant. Read-only candidate-code tracing found no runtime use of this field in the projection path. Projection/delivery instead require their integration/workspace authorization gates and active entitlement/principal checks. Keep the actual entitlement/projection counts distinct from this field; do not silently flip it or claim that checking it proves recipient authorization.
- This is fixture/precondition evidence only. Live discovery, normal-UI adoption, remote acknowledgment, replay/conflict and recipient/file-access acceptance remain required.

## Already supported

- `apps/operations/src/worker/project-alpha-project-adoption-candidates-api-v2.ts:12-39,41-69,71-113` implements bounded read-only `GET /api/v2/projects/adoption-candidates`. It requires the distinct `projects.adoption_candidates.read` capability and pins source instance, application, history epoch, request identity, pagination, and the minimal response shape.
- `apps/operations/src/worker/project-alpha-project-adoption-candidates-consumer.ts:32-53,55-92,95-131` filters remote candidates through current owner identity, live deny-aware `project.shared.sync` authority, exact active Directory mappings, and the current organization/client relationship. Discovery writes no review, outbox, binding, publication, or client-access state.
- `apps/operations/src/worker/project-alpha-private-admin-routes.ts:351-386,574-596` and `apps/operations/src/client/ProjectAlphaConnections.tsx:604-746` expose deliberate candidate review, reservation, and local bind planning behind the private administrator transport and adoption gate.
- `apps/operations/src/worker/project-alpha-project-adoption-review-producer.ts:268-330` preserves existing bound-project review and uses adoption candidates only after an exact binding-status `404`. Candidate fields must match a separate canonical detail read.
- `apps/operations/src/worker/project-alpha-project-adoption-bind-consumer.ts:247-276` copies the reviewed PA name and project fields into one native Operations head and creates one pending bind command. It does not publish a portal or grant client access.
- `apps/operations/migrations/0063_project_alpha_project_adoption.sql:67-83` enforces one local mapping per Operations Project ID and one mapping per `(source_instance_id, project_alpha_public_id)`. The review producer also rejects an existing local head, either-side mapping collision, or pending command at `project-alpha-project-adoption-review-producer.ts:187-198`.

## Exact implementation gaps

### 1. A new UI-selected Operations Project ID has no first-party destination reservation

The UI asks the owner for a **“New, unused Operations Project ID”** and submits it directly for review (`ProjectAlphaConnections.tsx:637-654,726-736`). The review producer, however, requires an already-existing exact row in `project_alpha_project_destinations` (`project-alpha-project-adoption-review-producer.ts:178-185,409-416`). No mounted first-party adoption route creates that row.

The focused D1 suite masks this prerequisite: `seedAuthority` inserts the destination before every successful review (`apps/operations/test/project-alpha-project-adoption-review-evidence-d1.test.ts:164-172`). The browser suite intercepts the APIs and therefore never exercises D1 destination creation (`apps/operations/test/browser/project-alpha-project-adoption.spec.ts:12-57`). A real owner choosing a genuinely unused ID can consequently discover a candidate but will receive a review outcome blocked as `destination`.

The normal Project command producer already establishes the safe pattern: it resolves the configured connection, rejects a conflicting destination, and inserts an absent immutable destination in the same atomic batch (`apps/operations/src/worker/project-alpha-project-v2-command-producer.ts:197-232`). Adoption should reuse that generic rule rather than pre-seeding D1 or accepting client-supplied connection coordinates.

### 2. Adoption stops at a queued bind, not a one-to-one acknowledged binding

The adoption bind route creates a local head and pending command only. The UI explicitly reports that PA acknowledgement is unconfirmed (`ProjectAlphaConnections.tsx:689-705,740-745`), and the browser test ends at that boundary (`project-alpha-project-adoption.spec.ts:94-100`).

Reusable lower-level dispatch, canonical read settlement, and activation functions exist, but normal adoption has no mounted server-owned continuation that consumes the reservation/command and completes those steps. The staging acceptance and recovery routes are not a general adoption coordinator. A queued command must not be reported as bound, and normal bound inventory/readback is not valid until settlement and canonical activation succeed.

## Staging gates and scopes

- The current checkpoint records the PA discovery implementation/image and a later read-only discovery window, but also records that the staging API key had not been granted `projects.adoption_candidates.read`: `docs/staging/portal-acceptance-checkpoint-2026-10-08.md:145,159-162`.
- Checked-in normal staging keeps `PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED` and `PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED` false: `apps/operations/wrangler.staging.json:55-56`. Acceptance profiles enable them deliberately; they must remain default-off outside an approved window.
- Candidate discovery deliberately does not accept an exact-project grant for an as-yet unbound PA project. It needs a least-privilege non-project-specific `project.shared.sync` grant whose business-area/division scope is derived from the already mapped organization/client. The relevant denial regression is `project-alpha-project-adoption-review-evidence-d1.test.ts:418-423`.
- Matching PA and Ops revisions, the PA discovery flag, the distinct discovery key scope, the Ops private/adoption gates, and current scoped owner authority must be verified together. Enabling inventory scope is not a substitute for discovery scope (`project-alpha-project-adoption-candidates-api-v2.test.ts:70-75`).

## Minimal aligned implementation and test order

1. Add a D1 integration regression that starts with an enabled configured source, current mapped organization, least-privilege scoped `project.shared.sync`, and **no** `project_alpha_project_destinations` row. Exercise candidate discovery, review, reserve, and bind. It must assert exactly one immutable destination, one Operations head with the exact PA name, one pending bind command, no PA mapping before acknowledgement, and zero workspace/publication/client-access changes.
2. In the first deliberate review action, atomically insert the absent destination from the server-resolved connection together with review evidence and its receipt. Preserve an exact existing destination, reject any conflict, and roll back destination/evidence/receipt together on failure. Update UI confirmation text to state that this action durably reserves the selected Operations ID to the exact PA source; it still does not bind, grant access, or publish.
3. Add an explicit authenticated adoption-finalization action that accepts only the durable server-owned reservation/command identity, then invokes the existing dispatcher, canonical read settlement, and activation stages with replay-safe outcomes and current-authority rechecks. Keep this a separate owner confirmation from review and reservation.
4. Add full-chain positive and negative tests for exact replay, uncertain dispatch, stale PA revision/projection, changed authority, destination collision, PA public-ID collision, atomic rollback, and post-activation normal inventory/readback. Assert the same project name on both sides and the one-to-one mapping.
5. Add explicit full-schema assertions that adoption never creates or activates workspace publication, folder publication, recipient enrollment, delivery authorization, or public-link rows. Publication remains a separate owner workflow.
6. Only after exact-revision local/CI evidence should a narrow staging window enable the PA discovery flag/scope, Ops private/adoption gates, and scoped Project authority. First prove the candidate read. Then run deliberate review/reserve/bind/finalize and normal bound inventory/readback. Close and independently verify every temporary gate, scope, and grant afterward.

If the immediate objective is only to make the synthetic PA project visible as an adoption candidate, no new PA protocol or inventory implementation is needed. The smallest live step is exact-revision deployment/configuration plus the narrow discovery scope and scoped Ops authority. The two Operations gaps above still block describing the browser workflow as complete PA-first adoption.
