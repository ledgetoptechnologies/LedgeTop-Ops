# Cluster integration investigation

## Evidence, not inferred outage

The user's setup routes Viewer to ClusterODX, which dispatches to two NodeODX containers. Reference source was inspected read-only under `C:/Reference Projects/ClusterODX-master`, `NodeODX-master`, and `WebODM-master` (each has a nested source directory).

Hermes subsequently reported both cluster and node task-info `imagesCount: 264` for provider UUID `e82d919a-5015-4474-a365-a99e2759f2a2`, matching Viewer's displayed source count. Provider output said `Loading 264 images`, `Found 264 usable images`, then `Caught TERM/INT signal, attempting to exit gracefully...`. Processing began at 2026-09-23 02:59:50.171 UTC, with recorded processingTime 76006 ms and terminal status code 50. This rules out photos never reaching the engine for this attempt. The signal does not identify its sender. Viewer submission fields and cancellation audit actor were not yet retrieved; node imagesCount must not be substituted for Viewer uploaded_file_count.

Live Viewer UI inspection showed Hickory Grove's 264-photo attempt as cancelled after 1m 52s. Its submit job completed, reconcile jobs ran, and retained provider output began with `Initializing ODM 3.5.6`. This proves that this particular submission reached the processing engine; it does not prove successful completion or establish who cancelled it. No job was launched, restarted or cancelled during this investigation.

The text “Unavailable means the processing API did not provide an authoritative value” is a survey-statistics explanation, not a provider connection error. Healthy describes the node probe; neither healthy nor missing survey statistics establishes task success.

## Confirmed output contract mismatch

NodeODX returns an array of output lines and ClusterODX forwards that array. WebODM consumes the list and joins its entries for display while tracking the consumed output position. Our old adapter converted the entire array with `String(value)`, joining records with commas, then advanced the cursor by the resulting newline count. Blank-line filtering also changed cursor semantics.

The live retained output corroborated this defect: each poll repeated a comma-joined configuration dump with its starting position advanced by only one original line; repository per-record truncation then hid most of the output.

The fix must preserve array record boundaries, blank records and exact cursor advancement, reject malformed/error responses, and sanitize each stored line independently. Existing corrupt historical records are not silently rewritten.

## Provider action acknowledgements

The reference implementations can return HTTP 200 with a JSON error for task actions. Transport success alone must not mark an upload or commit as accepted. Validate the response payload and preserve bounded, sanitized error reporting; retain compatibility with supported successful response shapes.

## References

- Local WebODM: `nodeodm/models.py`, `nodeodm/tests.py`, `app/models/task.py`.
- Local NodeODX: `index.js`, `libs/Task.js`.
- Local ClusterODX: `libs/proxy.js`.
- [WebODM task-output API](https://docs.webodm.org/api/reference/operations/projects_tasks_output/) documents the line cursor.

## Local verification

- Combined production Linux build and full suite: **1,607 passed, 31 skipped, zero failures** (1,638 tests). Retained test container: `viewer-task-workflow-combined-20260923`. Skips: 28 browser/asset-dependent checks, two native reconstruction checks, one host-bind check.
- Separate provider/dashboard browser fixture: **13/13 passed**, including desktop and 390/320-pixel mobile widths, inline selection/edit/preset flows, permission gating and navigation race checks.
- Focused provider/log/cancellation/session/UI output regression set: **22/22 passed**.
- The final sticky-sidebar offset is a CSS-only adjustment following that Linux snapshot; it receives a fresh browser/build check separately. No production job was used as a mutation test.

## Incident and live acceptance still open

The user reports that the Hickory Grove attempt stopped without their cancellation. In the inspected source, upstream cancellation becomes `failed / provider_cancelled`; the observed local `cancelled` state and cancelled pending reconcile job match `cancelAttempt()`. Its sole production caller is the authenticated cancellation endpoint. This narrows the path but does not identify the initiator. Hermes is checking the corresponding cancellation audit event and request logs; an authenticated actor alone cannot distinguish a person, another tab or automation. Do not declare this incident resolved from the log-format fixes.

A confirmation step now protects the Cancel processing action, including permission revalidation after the dialog. No production cancellation was performed to test it.

Provider output read failures are now best-effort diagnostics rather than a reason to fail healthy upstream processing or block completed-result ingestion. Abort/lease and local persistence errors still propagate. The 4 MiB response bound and 10 MiB retained-log cap remain; oversized backlogs and long-running log retention need a separate bounded streaming/tail solution, not unlimited buffering or cursor skipping.

Local contract tests do not constitute a completed real farm processing run. After deployment, validate a user-selected run through cluster upload, engine progress, output retrieval and result ingestion. Do not disturb the independently running WebODM task. Restart-from-stage remains a separate backend change described in `STAGE_RESTART_PLAN_2026-09-23.md`.
