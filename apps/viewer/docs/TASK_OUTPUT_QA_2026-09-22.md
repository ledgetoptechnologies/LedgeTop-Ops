# Task output follow-up

The active expanded task and Task settings now expose the latest 100 recorded log lines. Refresh runs every five seconds while the latest attempt is active; provider reconciliation currently runs on a separate cadence. Progress is the provider-reported value, not an estimated stage percentage. Stage labels are derived only from recognized processing-start messages, with an explicit unavailable-stage fallback. Quiet updates preserve log scroll/focus rather than rebuilding the workspace. They are single-flight, fence authorization changes, and fetch a changed latest attempt before pairing it with output.

## Known server retention limitation

`server/processingRepository.js` currently caps recorded attempt logs using `logMaxBytes` (default 10 MiB). `appendLog` stops accepting subsequent lines once the cap is reached; this is not a rotating tail. A long-running task can therefore show stale recorded output even though polling and provider processing continue. The UI's latest 100 lines are the latest **recorded** lines, not a guarantee that all recent provider output was retained.

No backend retention behavior was changed in this batch. Follow-up should implement bounded newest-tail retention with transaction-safe byte accounting, deterministic ordering, and an explicit truncation notice. Test sustained output beyond the cap, multibyte messages, concurrent append/read, retained recent errors, and downstream diagnostic/history compatibility before rollout. Download tail remains a bounded tail, not a complete processing transcript.

Provider output reads remain bounded to 4 MiB. A later scoped worker fix separates output-read/parse failures from authoritative upstream status: an unavailable or oversized log response records a fixed sanitized warning without advancing the output cursor, while running progress and completed-output ingestion continue. Cancellation, lease fencing and local log/cursor storage errors are still fatal to the reconcile operation. The bound is not removed and missing output is not fabricated. An oversized retained suffix can remain unavailable until a future bounded streaming or upstream pagination design handles it; it no longer falsely fails an otherwise healthy task.

Restart-from-stage also remains a separate design: existing Retry creates a new upstream task. Reusing intermediate outputs requires a dedicated durable restart contract, authorization/state checks, immutable output preservation, and explicit NodeODM restart options; it must not silently change the behavior of Retry or restart an active task.

No processing job was launched or restarted, and no Operations files were changed.
