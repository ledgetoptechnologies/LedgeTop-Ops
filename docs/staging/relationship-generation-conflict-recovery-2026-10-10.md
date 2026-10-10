# Directory relationship generation conflict recovery

Status: design only. No migration, runtime route, feature flag, authorization grant, or provider write is authorized by this document.

## Decision

Add a default-off, administrator-reviewed recovery workflow for one narrow state: an immutable Directory relationship command is terminal because Project Alpha rejected its stale authorization generation, while Operations still holds the command's intended relationship as its canonical current state and a fresh trusted Project Alpha read proves that the corresponding relationship mutation has not occurred remotely.

Recovery creates an immutable successor command. It never edits, requeues, or deletes the terminal command; never rolls the Operations relationship backward merely to make the existing relationship writer accept a new mutation; and never treats a binding row alone as proof of the client's current parent. The existing `relationship-recovery` route remains for a genuine later relationship change. It cannot safely perform same-state recovery because it rejects the current organization as `no_change`, while remove or move commands derive their expected remote parent from the current Operations organization.

## Eligible conflict

All of the following must be true in one review snapshot:

- The predecessor is the exact immediate `terminal` relationship command for every selected destination and its outcome is the existing strictly parsed generic HTTP 409 relationship-conflict response. A 409 alone is never classified as a generation conflict: the server must replay the byte-identical predecessor request to obtain the same generic conflict, then use fresh canonical reads to prove that the expected relationship mutation is still unapplied and that only the authorization generation advanced. If Project Alpha later adds a safe structured relationship-generation conflict code, pin that provider contract and require it in addition to the canonical reads; do not infer or manufacture the create endpoint's `authorization_generation_conflict` code for relationship writes.
- The predecessor action is `assign`, `remove`, or `move`, and its frozen command, request, source tuple, destination origin, client ID, relationship version, resource revisions, public IDs, and expected current organization are internally consistent with the immutable Operations history and mapping evidence.
- The current Operations relationship still equals the predecessor's intended post-command state at the same relationship version. No later local relationship history or command exists.
- A fresh authenticated API v2 inventory/read from the exact configured source instance, application, history epoch, and origin proves the client public ID and revision, the remote current parent, the target organization public ID and revision when applicable, all required bindings active and exact, and one current authorization generation.
- The remote parent equals the predecessor's expected pre-command parent, not its intended post-command parent. This proves the relationship mutation is still needed. If remote state already equals the intended state, use a separately designed acknowledgement/reconciliation workflow; do not send another mutation.
- The fresh client and organization revisions equal the revisions required by the successor command. Any revision, parent, mapping, binding, source identity, history epoch, or generation disagreement fails closed.
- The reviewer is a current administrator with current admission/profile identity and exact live `directory.profile.view`, `directory.profile.edit`, `directory.identity.link`, and `directory.enrollment.manage` authority for the client and every previous/target organization. An active deny wins.

The first supported release should limit eligibility to the observed simple assign case unless remove and move receive independent contract tests against Project Alpha. Generalizing the schema now is acceptable; enabling unproved actions is not.

## Review lifecycle

1. An administrator opens a recovery review from the read-only client profile status. The server derives the terminal predecessor; the browser never supplies an unverified predecessor as discovery evidence.
2. `POST /api/client-hub/directory/standalone-clients/:recordId/relationship-generation-recovery/reviews` performs fresh Project Alpha reads, persists the normal inventory receipt, and creates a sealed review candidate. It returns only sanitized identities, revisions, relationship states, generation, terminal command ID, expiry, and a review ID.
3. The UI displays Operations current state beside the fresh remote state and explicitly states the successor command that will be reserved. The reviewer must confirm that no local relationship will be changed.
4. `POST /api/client-hub/directory/standalone-clients/:recordId/relationship-generation-recovery/reviews/:reviewId/authorize` requires a new authorization ID and successor command ID, an `Idempotency-Key` equal to the authorization ID, the sealed review digest, and a non-empty reason.
5. The server rechecks current administrator identity, grants, configuration, canonical relationship, immediate predecessor, mappings, enrollment, source tuple, review expiry, and latest persisted generation. One D1 batch inserts the authorization ledger row and a row in the dedicated recovery outbox. It does not update the canonical relationship row, relationship history, or predecessor.
6. The relationship dispatcher loads the recovery row through an explicit effective-command abstraction and sends it only after a dedicated pre-send recovery validator confirms the ledger, current actor identity, exact selected grants, immutable root command, immediate terminal predecessor, and unchanged source/configuration. A success uses the existing acknowledgement parser and recovery-specific durable settlement.

Review creation is read-only toward Project Alpha. Authorization reserves a local outbox command; dispatch is the only remote mutation boundary.

## Persistence design

Add one forward-only migration after the currently reviewed chain, provisionally named `0184_project_alpha_directory_relationship_generation_recovery.sql`. Final numbering must be chosen from the release branch at implementation time.

Create `project_alpha_directory_relationship_generation_recovery_reviews` with:

- `review_id` primary key, client record ID, source identity tuple, destination origin, predecessor/root command IDs, relationship version and action;
- exact local before and intended organizations, client and organization record versions, external IDs, public IDs, and expected Project Alpha revisions;
- remote client revision, remote parent public ID, target binding status and revision, observed authorization generation, inventory request/receipt IDs, and an evidence SHA-256;
- reviewer identity/admission/profile versions, selected grant IDs, created/expiry timestamps, and state (`open`, `authorized`, `expired`, or `invalidated`).

Create `project_alpha_directory_relationship_generation_recoveries` with:

- `authorization_id` primary key, unique `successor_command_id`, predecessor/root command IDs, review ID, recovery depth, client record ID, source tuple, and destination origin;
- the full observed evidence digest and generation, exact predecessor command JSON/outcome digest, exact successor command JSON, reason, actor identity versions, and selected grant IDs;
- authorization and expiry timestamps. Recovery depth is initially limited to one; a successor conflict requires a new design decision rather than an unbounded chain.

Create a separate `project_alpha_directory_relationship_recovery_outbox` rather than inserting the successor into `project_alpha_directory_relationship_outbox`. The original table deliberately has `UNIQUE(mutation_id, source_id, source_instance_id, application_id, history_epoch_id)`, and its live-command view requires the command mutation and relationship version to join the one canonical history mutation. A same-version successor has neither a new canonical relationship mutation nor a new history row, so putting it in the original outbox would violate or weaken those invariants.

The recovery outbox carries the dispatch fields (`command_id`, source tuple, destination origin, client public ID, action, command/request JSON, state, attempts, lease fields, next-attempt time, outcome, and timestamps) plus a unique recovery authorization ID and exact predecessor command ID. Its foreign keys point to the immutable recovery ledger and original predecessor. It has no independent mutation ID and cannot participate in the original history join. Unique constraints allow one recovery successor per authorization and one active/terminal successor per predecessor. Add no permissive union to `project_alpha_directory_live_relationship_commands`, and do not drop or relax the original outbox uniqueness, insert guard, history mutation join, relationship-version join, or expected-previous-organization checks.

Create a narrow `project_alpha_directory_effective_relationship_commands` projection with a discriminator (`normal` or `generation_recovery`) and only the columns needed by scheduler/dispatcher/status consumers. Its normal branch selects commands already admitted by `project_alpha_directory_live_relationship_commands`. Its recovery branch selects recovery-outbox rows only when an immutable authorization ledger row, sealed review, exact original terminal predecessor, unchanged canonical relationship/history target, and exact mappings/enrollment/source tuple are present. Environment flags cannot be enforced by a D1 view, so runtime selection and pre-send validation must independently require the default-off flag. The projection is a read abstraction, not authority by itself.

Add indexes for review expiry/state, recovery readiness, predecessor lookup, and unique predecessor-to-successor recovery so concurrent authorizations cannot fork.

Use SQL triggers to reject:

- non-terminal, non-immediate, wrong-source, or already-superseded predecessors;
- predecessor outcomes that are not the exact existing generic relationship-conflict shape, or evidence sets that do not include byte-identical replay plus canonical reads proving the mutation unapplied and generation advanced;
- any recovery-outbox successor whose source tuple, client public ID, action, expected remote parent, organization payload, revisions, or command body differs from the sealed review;
- a successor generation other than the sealed freshly observed generation;
- local relationship/history, enrollment, mapping, binding, record-version, staff identity, admission/profile, selected-grant, deny, or review-state drift;
- mutation of recovery ledger rows after insert.

The authorization transaction inserts the ledger and dedicated recovery-outbox row together. A trigger or affected-row assertion makes partial reservation impossible. The old terminal row remains byte-for-byte unchanged and terminal.

## Runtime boundaries

Add:

- `project-alpha-directory-relationship-generation-recovery.ts` for fresh evidence acquisition, candidate sealing, authorization replay, and current-state validation;
- `project-alpha-directory-relationship-generation-recovery-proposal.ts` as a pure constructor that accepts a validated predecessor plus sealed remote evidence and returns the exact successor command;
- focused route handlers in `native-directory-profile-routes.ts`, or a separately registered route module if that keeps the current file reviewable;
- an effective relationship-command repository used by `project-alpha-directory-relationship-outbox-dispatcher.ts` to load, lease, release, and settle either normal or recovery commands without dynamically choosing table names from request data;
- a recovery pre-send validator called only for rows discriminated as recovery commands.

Reuse the create-generation recovery boundaries for configured connection resolution, fresh inventory reads, receipt persistence, signed-int64 generation parsing, immutable authorization replay, live grant selection, depth limit, and insert-time SQL guards. Reuse the relationship transport and acknowledgement parser for dispatch, but not the create endpoint's structured generation-conflict validator. Do not reuse the normal relationship writer for successor construction: it necessarily derives the command's remote precondition from the current local relationship and increments the local relationship version.

The compatibility change must audit and deliberately adapt every direct original-outbox consumer. At minimum this includes `native-directory-outbox-scheduler.ts` readiness selection; `project-alpha-directory-relationship-outbox-dispatcher.ts` load/live/lease/release/terminal/acknowledged transitions; `native-directory-profile-routes.ts` delivery settlement, public status, replay lookup, and immediate-predecessor discovery; `native-directory-relationship-writer.ts` replay, current-command count, predecessor selection, and authorization/race checks; `native-directory-profile-writer.ts` unsettled relationship checks; and the migration-defined relationship revision-evidence and validated acknowledgement/materialization views used downstream. Normal writes continue to use only the original table. Status and evidence consumers use the effective projection only where a recovery acknowledgement is semantically equivalent, and must preserve the discriminator and root predecessor provenance.

The scheduler may select recovery rows only while the feature is enabled. It passes the command ID and discriminator to the dispatcher; it must not rely on command ID collision fallback between tables. A recovery acknowledgement feeds a dedicated recovery acknowledgement view, then a guarded union into relationship revision evidence. It must not retroactively turn the predecessor into acknowledged or cause two acknowledgements to count for one relationship version. Delivery settlement treats the relationship destination as settled when either the original command is acknowledged or its one exact authorized recovery successor is acknowledged, never by row count alone.

Add `PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED`, default `false` in types, local/staging/production configuration, generated types, release invariants, and deployment profiles. Both review and authorization routes return 404 while disabled. Dispatch must also reject a recovery successor while disabled; disabling the feature revokes unsent recovery authority without altering evidence.

## UI and operator status

Extend the native client profile response with a sanitized delivery status, not raw outbox JSON: `settled`, `pending`, or `terminal_generation_conflict`, plus whether an administrator may open a review. Do not expose command bodies, private PA errors, grants, tokens, or unvalidated command IDs.

For an eligible terminal conflict, the editor remains read-only for ordinary relationship changes and shows “Project Alpha relationship delivery needs review.” Administrators get “Review generation conflict”; other users get status only. The review dialog shows the local intended parent, remote current parent, exact client and organization revisions, observed generation, evidence time/expiry, and the no-local-mutation statement. Authorization has an explicit confirmation and reason field.

Browser retries reuse the same review ID, authorization ID, successor command ID, request body, and idempotency key. Exact replay returns the existing prepared result. Changed-body reuse returns 409. Refreshing the page retrieves status from the server; browser storage is not authority. Status distinguishes `review_expired`, `evidence_changed`, `authority_revoked`, `prepared`, `dispatch_pending`, `acknowledged`, and `terminal` without inviting blind retry.

## Race and revocation behavior

- A fresh PA read followed by any newer persisted generation before authorization invalidates the review.
- Any local relationship/version, mapping, enrollment, record revision, source configuration, actor profile/admission, allow-grant selection, or deny change invalidates authorization.
- Any concurrent successor reservation wins through the unique predecessor constraint; the loser receives an exact replay or conflict.
- Revocation before dispatch prevents sending. Revocation after a verified acknowledgement does not erase historical evidence or acknowledgement validity.
- Transport outage keeps the identical successor pending under existing retry behavior. A 409 makes the successor terminal; it is never rewritten with a newer generation.
- Lost lease and uncertain response retain existing dispatcher semantics. No recovery-specific code infers success from a timeout.

## Required tests

Migration and SQL tests must cover exact-chain application, immutable rows, unique predecessor supersession, trigger rejection for every drift dimension, atomic rollback, signed-int64 boundaries, depth limit, and no changes to canonical relationship/history or the predecessor.

Runtime tests must cover eligible assign recovery, generic 409 without corroborating reads, byte-changed replay, replay that no longer conflicts, remote already-applied state, wrong parent, inactive/missing organization binding, client or organization revision drift, unchanged or multiply advanced generation, mismatched source identity/origin/history epoch, malformed/private error envelopes, expired review, wrong reviewer, administrator loss, admission/profile drift, allow-grant replacement, deny insertion, enrollment/mapping/configuration drift, and feature disablement at review, authorization, scheduler selection, and pre-send.

Idempotency tests must cover exact review/authorization replay, changed-body reuse, duplicate successor ID, concurrent authorization, stale review after a newer inventory receipt, dispatcher replay after acknowledgement, outage retry with byte-identical command JSON, terminal successor preservation, and no recovery chain beyond the configured depth.

UI/API tests must prove ordinary users cannot authorize, raw evidence is not exposed, ordinary relationship editing stays blocked, the dialog renders the sealed comparison, refresh resumes server status, confirmation is explicit, and no button recommends remove/re-add. Browser tests must exercise same-origin/CSRF enforcement and confirm the route is absent while the flag is off.

Regression tests must prove the existing genuine-change `relationship-recovery` route, normal relationship writer, original outbox uniqueness and live-history guards, create-generation recovery, inventory persistence, scheduler selection, and acknowledgement validation retain their current behavior. Full-chain tests must prove a recovery row cannot enter the original live-command view, cannot satisfy ordinary replay/history queries accidentally, and reaches revision evidence only after its own exact acknowledgement guard passes.

## Release gates

Implementation cannot be enabled until the migration and Worker artifact are reviewed together, full focused D1 and route/UI suites pass on the immutable candidate, configuration hashes include the default-off flag, and Project Alpha's relationship conflict and read contracts are pinned by fixtures from the reviewed provider version. Staging enablement requires a synthetic-only operator plan, current administrator/grant review, clean migration ledger, and an explicit rollback that disables new recovery preparation and dispatch without deleting ledger evidence.

Success is one acknowledged successor whose request uses the freshly observed generation, whose acknowledgement matches the exact source identity and intended relationship, whose predecessor remains terminal and immutable, and whose Operations canonical relationship never changes during recovery.
