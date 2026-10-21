# Task workflow follow-up

## Implemented in this batch

- Separate Choose files and Choose folder buttons. Both open native selectors directly; folder recursion and original-file preservation remain unchanged. No application confirmation is added. The browser's native directory-upload confirmation cannot be disabled by the page.
- Existing preset selection plus one-time task overrides and Save as preset on the New task page. Saving creates a new capability-bound preset and selects it; existing presets are not silently changed. False/zero values remain meaningful. Preset creation requires the existing provider-write permission and retains an idempotency key across identical failed requests.
- Photos, processing node, preset, alignment, and task options are ordered together. Alignment currently states Automatic and clearly explains that a prior-survey reference workflow is not available; it does not offer a nonfunctional reference picker.
- Local GPS preview renders and frames the first located photo immediately, then adds bounded marker batches. User pointer/wheel/key interaction stops automatic reframing. Server-folder metadata still arrives as one response; it is not a streaming API.
- Preparation explicitly describes local integrity checksums. Browser transfer shows completed/total photos, acknowledged bytes, average transfer speed and a determinate progress bar. Resume counts already accepted bytes without inventing transfer speed. Server assembly is a separate phase, not a claim that node processing is complete.
- An independent New task dialog can be hidden while upload/preparation/submission continues in the same tab. A persistent activity panel reopens it or explicitly stops/discards local work. A beforeunload warning is present only while browser-owned work is active. Success, explicit disposal and authorization loss retire the controller and warning. Accepted server operations and original source files are not deleted by local cancellation.
- Active expanded tasks now render live output, recognized ODM stage markers and provider-reported progress. Task settings keep output available after completion. Five-second UI polling retains scroll/focus, prevents overlapping requests, and fences stale authorization/attempt responses.

## Verification

- Combined upload, metadata/map, options, output, layout, dashboard and shell suites: **73/73 passed**, zero skips.
- Expanded isolated Chromium-family New task suite: **15/15 passed**, zero skips/errors. Covers real native picker dispatch, presets and idempotent retry, one-time values, background navigation/reopen, unrelated modal preservation, beforeunload lifecycle, failed-work discard and abort/late-response retirement. APIs are isolated fixtures; no customer processing task was launched or restarted.
- Production Vite build passed. Existing loaders.gl CommonJS and large-bundle warnings remain.
- Preset CRUD, task submission and session-renewal/controller suites: **33/33 passed**, zero skips. Auth-loss upload disposal regression: **3/3 passed**.
- The initial full Linux workflow snapshot passed **1,594 tests with 31 skips and zero failures**. Windows full-run storage tests cannot use Linux `/proc/self/fdinfo`; Linux is the production verification environment. Additional cluster fixes receive a subsequent full snapshot check documented in the cluster QA note.
- Desktop/mobile and preset/background screenshots retained under `tmp/new-task-browser-qa/` for visual review, not committed. Fixture basemap network is mocked; these images do not prove external satellite tile availability.

## Not yet implemented / release acceptance still required

- **Restart from a specific stage** needs its own durable remote-task restart command, schema ownership rules and ambiguous-response handling. Current full restart creates a fresh provider task. See `STAGE_RESTART_PLAN_2026-09-23.md`; do not substitute a rerun flag on a fresh upload or route an existing UUID through destructive submission recovery.
- **Alignment to a prior survey** needs registered reference assets/provenance and provider transport support. No arbitrary server file path is accepted.
- Existing backend logs stop recording after the configured 10 MiB cap. This batch does not delete or rotate historical logs. See `TASK_OUTPUT_QA_2026-09-22.md` for the remaining retention work.
- Native unload prompts depend on browser policy/user activation and cannot guarantee survival of browser crashes or forced closes. Keep the tab open until submission completes.
- Live acceptance of this batch requires deployment. Hickory Grove's running job, Operations code and existing source/measurement data were not modified during implementation.
