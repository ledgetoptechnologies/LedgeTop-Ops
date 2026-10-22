# Stage restart plan — 2026-09-23

Status: **design only; same-remote-task stage restart is not shipped.** Current retry creates a fresh local attempt and fresh provider UUID, uploads inputs, and starts a new job. A `rerun-from` option on that fresh job is not equivalent to reusing a retained NodeODM task.

## Existing hazards and invariants

- `processing_attempts` has `UNIQUE(provider_id, provider_task_id)`. A second immutable local attempt cannot currently reuse a remote UUID.
- `createAttempt()` queues `submit`; `processSubmit()` calls `adapter.remove()` when an existing remote task is found with submission phase `new`. **Never route a stage restart through this recovery branch:** it deletes retained upstream state.
- A restart must get a new local attempt ID, immutable option/input provenance, its own logs and output directory. Keep the source attempt and its results unchanged.
- Existing ingestion uses `models/<taskId>/<attemptId>`, versions keyed by attempt ID, and `makeActive:false`. Preserve that contract: published assets, active version, shares, and measurements stay available until explicit publication of the new result.
- Only one execution may own a provider/remote UUID at a time. An action on an old attempt must never cancel or remove a newer execution.

## Schema and repository changes

Design a reviewed migration replacing unconditional remote-UUID uniqueness with explicit execution ownership. Retain historical remote UUIDs, introduce source-attempt lineage and a generation/ownership record keyed uniquely by `(provider_id, remote_uuid)`, and bind the current owner to the fresh attempt. Do not clear the old attempt's remote identity to work around the constraint.

Persist a restart-command record with source/new attempt IDs, chosen stage, complete validated options and capability fingerprint, actor/idempotency receipt, original input/GCP provenance, dispatch state, timestamps, and acknowledgement/reconciliation evidence. States must distinguish queued, dispatch-intent, acknowledged, ambiguous, and rejected; an HTTP timeout is not proof of rejection.

Repository creation must atomically verify task/project eligibility, latest applicable source attempt, terminal local work, absence of leased/pending jobs or derivatives, and exclusive remote ownership. Include restart jobs in provider admission, capacity reservations, lifecycle locks, cancellation, and recovery rules. Keep published metadata unchanged on failure.

## API and provider contract

Add staff-only `POST /api/v1/attempts/:id/restart` under `viewer.processing.write`, normal mutation/idempotency checks, and live-worker admission. Initially accept only `{stage, capabilityFingerprint}`; derive provider UUID, dataset and full options server-side. Client/public measurement access never authorizes processing.

Confirm the original remote task exists and is completed, failed, or cancelled. Reject active upstream work even if local cancellation already appears terminal. Require an enabled, healthy provider and current capabilities. Offer stages from the advertised `rerun-from` domain intersected with supported stage labels, not a permanently hard-coded menu.

Preserve the original full options and original GCP/alignment inputs, remove conflicting rerun selectors, set the chosen stage, and validate all values plus required Viewer outputs. Do not silently use newly edited GCP marks without uploading new inputs.

Add an adapter call to NodeODM `POST /task/restart` with the existing UUID and serialized complete options array; NodeODM documents these options as replacing the previous options. Validate response success and error bodies, not just HTTP status.

## Worker and ambiguous commands

Use a dedicated restart job/dispatch path which cannot reach initialization, input upload, or remove. Persist dispatch intent before the network call and acknowledgement afterward. On acknowledgement, reconcile into the ordinary monitoring/ingestion pipeline under the new attempt; start its output cursor independently.

Do not apply generic exponential command retries to an ambiguous restart response. The first command may already have succeeded, potentially finishing before recovery observes it. An upstream `completed` state alone cannot prove that the requested generation ran, and must not cause ingestion of old output as new work. Establish trustworthy provider-generation evidence where supported; otherwise expose an explicit ambiguous state requiring staff reconciliation rather than resending or claiming success. This protocol and its migration require dedicated review before implementation.

## Retained state and user messaging

ODM `optimize-disk-space` deletes heavy intermediate files and limits intermediate-stage restart. Do not promise availability simply because the remote UUID exists. Disable intermediate restart when original settings indicate removed prerequisites unless retained prerequisites can be verified. Expired/missing remote tasks or missing intermediates should explain why restart is unavailable; offer fresh full reprocessing as a separate explicit action, never a silent fallback.

UI labels must distinguish **Retry / reprocess from original photos** from **Restart retained task from stage**. Hide the latter until the server advertises eligibility and the safe dispatch path exists. Do not launch a real farm job merely to exercise this control without an explicitly selected test run.

## Minimum acceptance tests

1. Migration preserves attempts, remote identities, outputs and active versions; duplicate current ownership is impossible.
2. Concurrent requests and replayed idempotency receipts create one local execution/command; conflicting payloads fail.
3. Client/read-only access, arbitrary UUIDs/paths, unsupported stages, stale capabilities, disabled/unhealthy providers, and running remote tasks are rejected.
4. Cancelled-but-still-running upstream work, active derivatives/ingestion, and outdated source attempts cannot restart.
5. Adapter sends the original UUID and full validated options; no initialize/upload/remove calls occur.
6. Missing tasks and `optimize-disk-space` limitations are explicit, with no automatic full-run fallback.
7. Crash before dispatch, after dispatch intent, after remote acceptance, and after acknowledgement cannot duplicate restart or ingest an old generation. Test fast completion plus lost response.
8. Old-attempt cancellation cannot affect the new owner. Restart cancellation retains all previously published output.
9. New logs/cursor, reservations, lease recovery, and terminal events are isolated to the new attempt.
10. Failure leaves prior assets/hashes/publication unchanged; success creates a separate reviewable version, activated only through normal publication authorization.

## Sources and local implementation references

- [NodeODM API — POST /task/restart](https://raw.githubusercontent.com/OpenDroneMap/NodeODM/master/docs/index.adoc)
- [ODM optimize-disk-space documentation](https://docs.opendronemap.org/arguments/optimize-disk-space/)
- `server/database.js`: processing attempts/jobs constraints.
- `server/processingRepository.js`: `createAttempt`, `retryAttempt`, `claimJob`, lifecycle transitions.
- `server/processingWorker.js`: `processSubmit`, `processReconcile`, `processIngest`.
- `server/nodeOdmProvider.js`: bounded provider requests and existing cancel/remove methods.
- `server/processingApi.js`: attempt creation/retry/cancellation/publication authorization.
