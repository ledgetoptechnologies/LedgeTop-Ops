# Portal release consolidation checkpoint

## Current status — 2026-10-04

- The isolated consolidation branch merges API-v2 candidate `65d62fa01d87cb3e9cc51f42add23e35897ed4e9` with the tracked recipient implementation at `2a4e4d5053452b55ea8409f480a87f8ef6caa990`.
- The merge is not yet resolved, committed, tested, pushed, or deployed. This document is a work record, not acceptance evidence.
- The original clean API-v2 candidate remains unchanged while its full local release gate runs.
- Recipient enrollment and explicitly selected-folder delivery authority require the complete tracked schema/runtime lineage. Enabling diagnostic staging flags or passing service-summary checks does not prove client file access.
- Preserve API-v2 configured source/application/history identity checks, Ops/PA record-ID separation, canonical project proof, and pagination-safe mirror suppression when resolving runtime conflicts.
- Preserve recipient proof verification, explicit owner confirmation, audited/idempotent enrollment, cancellation/recovery, selected-folder authority, and revocation checks from the recipient lineage. Keep those capabilities default-off in checked-in release configuration.

## Migration hold

- Both branches independently introduced distinct Operations migration filenames with prefixes `0125` through `0131`. Git can combine these files without reporting a conflict; that does not prove their execution order is correct.
- Some files are equivalent schema changes under different filenames. Applying both can recreate or overwrite authorization objects, even if migration ledgers treat them as different entries.
- Compare SQL bodies, object dependencies, guard replacements, and existing applied filenames before choosing a canonical sequence. Do not rename an already-applied migration, replay equivalent SQL blindly, or weaken a trigger to make the sequence pass.
- The read-only semantic audit identifies the candidate's `0129` activation as byte-identical to the historical `0125` activation. Its inventory/claim/field-review migrations match historical `0161`/`0162`/`0163`; its generation-scope SQL matches historical `0165` apart from a comment. These are duplicate executable changes, not additional release requirements.
- Keep the historical activation/relationship/binding sequence intact. The newer canonical-record-ID view and refresh/update guard corrections must follow it; replaying the older `0131` guards afterward would restore the wrong acquired-record-ID semantics.
- The complete historical chain through `0169` is tracked at `codex/pa-ops-clienthub-0169-staging`, revision `96d176bb87b9e481f21c15bb49b0c2d00b969056`, a descendant of the recipient branch. Its complete delta, including Client `0222`–`0228`, native recipient/publication/delivery runtime and read-adoption support, must be integrated before finalizing the inventory. Importing only its SQL would create schema/runtime skew.
- Do not substitute the later remote tip: it includes `0170_client_hub_canonical_directory_projection_reset.sql`, which is not part of this acceptance step. Preserve the exact guard filenames already applied in the separate staging packet; inspect the live ledger before considering any projection reset.
- Seven release-script conflict resolutions pass static syntax checks, but their transitional migration-count pin is not release-ready evidence. Recompute inventory/count/hash contracts after complete lineage and duplicate reconciliation; do not deploy the transitional merge.
- Existing populated staging history and the fresh canonical release chain require separate evidence. A disposable full-chain rehearsal must prove the consolidated canonical sequence; a reviewed forward-only packet must prove the upgrade of existing staging.
- Earlier staging guard readback establishes only those exact view/trigger changes. It does not establish acceptance of this merged runtime or the recipient workflow.

## Required acceptance before the production PA checkpoint

- Resolve all merge conflicts and regenerate binding types from the combined configuration.
- Run the complete canonical migration chain, upgrade/negative regressions, type checks, build, and release gates on the exact committed revision.
- Preserve the separately enabled staging Viewer integration/processing window when deploying Ops. Never silently overwrite it from a default-off baseline.
- Verify bounded PA inventory and explicitly selected customer/project mapping against current source identities, including conflict and replay behavior.
- Verify signed-in recipient enrollment, selected-folder browsing, sibling/cross-customer denial, revocation, and expired-session denial in the real staging browser flow.
- Verify existing public links remain unchanged and usable before and after the staging acceptance window.
- Record exact PA/Ops revisions, configuration, migrations, and validation order for the owner's production update checkpoint.

## Boundaries

- No production PA update, production client-access activation, or portal cutover is authorized by this consolidation.
- No existing public links are changed.
- Do not delete `main`, `dev`, branches with unique commits, or branches required by active worktrees.
