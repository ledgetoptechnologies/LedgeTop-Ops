# Requested changes: implementation and verification status

This audit distinguishes shipped Viewer behavior, local work in progress, and deployment acceptance. It does not claim Operations changes or real farm processing have been verified.

## Shipped Viewer measurement and navigation work

The latest released baseline is `d43b83e`. Its production image passed the exact-container release gate. The last checked live server was still `be8e853`; deployment acceptance of the follow-up fixes remains pending.

| Request | Current evidence / qualification |
| --- | --- |
| Resizable sidebar and two visible measurement cards with orange overflow | Implemented. Pointer, keyboard, narrow-layout and interrupted-drag tests pass. |
| Load personal saved measurements automatically without recalculation | Implemented. Follow-up fixes Retry visibility after successful loading. |
| Shared measurements across model, cloud, orthophoto, DSM and DTM | Implemented with per-user, model-version and access boundaries. Geometry editing stays in the original compatible view family to avoid replacing measured heights with map placeholders. |
| Public measurements reset on refresh; clients cannot run processing jobs | Separate ephemeral/public and signed-in personal paths are tested. Measurement calculations are distinct from privileged data processing. No Operations implementation is claimed here. |
| Inline rename, Hide/Show, Edit, move/add/delete vertices and export all | Implemented. Hidden measurements remain in exports; invalid geometry is rejected. |
| Area immediately, volume only after Calculate volume | Implemented according to the user's later clarification. Opening a saved result does not recalculate it. |
| Saved volume displayed with its name, View volume, stale-outline recalculation | Implemented; `d43b83e` fixes persisted server `complete` status recognition. Negative net values are preserved. |
| Floating Save view image and separate Model report | Implemented. Isolated browser checks verify actual PNG bytes and report rendering. Native PDF/download delivery in the user's browser still needs confirmation. |
| Automatic cross-section, numeric inputs/sliders/reset/loading and explanations | Implemented and browser-tested, including cancellation and coalescing. Profile changes do not change saved volume. |
| Large stockpiles | Higher bounded native capacity and exact spatial patch culling are implemented. Actual County DSM reference remains numerically consistent. Polygon 1 is not reproduced because its CSV lacks vertices; JSON is required. Limits are not removed entirely. |
| Point-cloud reset, fixed sizing, no intensity option, classification readout and one dual-thumb elevation range | Implemented and covered by focused tests. Classification readout uses actual decoded classes, not inferred labels. |
| Preserve 3D viewpoint across model/cloud/map switches | Implemented and tested across 13 scenarios. Reload persistence was not required by the user. |
| Camera-pin performance and DSM/DTM detail | Bounded/cached map overlays and physical-spacing hillshade paths are covered by tests. These are not a universal live FPS guarantee. |
| Point-cloud detail/refinement without sacrificing requested budget | History and loaded-navigation evidence are in the refinement QA document. User reported smooth movement before the recent measurement release; the follow-up makes no renderer or budget reduction. |
| Compact project/task layout, no repeated project header, GCP separate workspace and product downloads | Implemented. Project/task tests cover unified expansion, quick actions, honest source counts, dedicated GCP page and permission gating. |

Fresh audit evidence at `d43b83e`: 90 focused measurement tests and 26 isolated real-browser tests passed without skips, plus 84 earlier-control/measurement/privacy/viewpoint tests. The release's full Linux source suite had 1,542 passes, zero failures and 30 environment-dependent skips. These counts cover different test selections and must not be summed as distinct coverage.

## Newly authorized New Task phase: local work, not yet released

- New task opens on an empty project. Toolbar order is New task, Share, More; secondary actions remain permission-gated.
- Task name defaults to the project name and local date.
- PC individual images or nested parent folders create a fresh managed source dataset. Chunk transfer is bounded and resumable; duplicate names are disambiguated in processing copies.
- Server folder/image selection uses the same import mount, including raw/ when present. Recursive copying preserves the originals. Preparation is durable; closing the form is not cancellation of accepted work.
- Only an eligible healthy node is selectable; the sole eligible node is selected automatically. Busy-but-queueable is distinguished from unavailable. Server submission rechecks eligibility.
- Existing optional presets remain available when compatible. No new preset editor or resizing pipeline is claimed.
- GPS photo preview is implemented using the same strict EXIF parser on PC and server paths. It displays locations without a basemap and shows recorded true heading on hover; missing GPS stays explicit. Actual Vite/Leaflet browser checks cover reselection, delayed scans, source switching and closing without late canvas exceptions.

The combined Linux suite passed 1,567 tests with zero failures and 31 skips. Final shared-parser/server changes passed 18 Linux tests with no skips; final focused workspace/upload/map/provider checks passed 56 tests. These overlapping test selections are not additive. These are local verification results, not confirmation of a deployed processing run.

No real provider processing job has been launched. End-to-end cluster processing and output ingestion still require an agreed representative run, ideally with Hermes on the server.

## Not implemented in this phase

Advanced typed preset editing/import/export, resize-to-2,048 processing copies, reconstruction-boundary editing, GCP workflow changes, and an upstream option watcher remain later work. Finished-model importing remains a separate existing workflow. No recurring watcher was scheduled. No Operations code was changed.
