# Measurement usability follow-up — 22 September 2026

## Implemented behavior

- Drag the navigation edge to resize it; keyboard arrows, Home and End work on the focused separator. Desktop resizing preserves a useful viewer width; narrow screens retain the overlay layout. Interrupted gestures release capture.
- Saved measurements load asynchronously without starting volume jobs. Retry is shown only after a loading failure.
- Measurement names open inline renaming. Cards provide Hide/Show, Edit and Delete; hidden cards are muted. Exports include all saved records, including hidden ones.
- Edit supports dragging vertices, midpoint insertion and selected-point deletion with the contextual control or Backspace. Invalid completed outlines are rejected; Shift preserves navigation. Editing remains within compatible view families to avoid replacing 3D heights with map placeholder elevations.
- Unchanged edits retain results. Changed outlines invalidate volume and prompt explicit recalculation. Saved results open with View volume; opening a result does not recalculate volume.
- Overlay labels group the name and saved volume. Signed net quantities remain signed.
- Save view image is beside reset/fullscreen. Model report is a separate sidebar section above Camera. Reports include all saved measurement tables even if capture or image encoding fails, with an explicit warning. Capture still respects access and view changes; unavailable overlays are disclosed on quick images.
- Accepted volume jobs show a brief background-work notice. Page/dialog closure does not cancel accepted jobs, but expiry/revocation of the original authorization still does. No promise of completion after sign-out or expiry.
- Cut, fill, net and coverage have explanations. Technical staff settings are below ordinary results.
- Native elevation profiles load automatically. Slider and numeric inputs stay synchronized; Reset restores center/zero direction. Updates are debounced and coalesced behind one request. Loading state is explicit; failures expose Retry. Profile updates do not change saved volume.

## Large stockpiles

The default and hard native-raster selection ceiling is now 100 million bounding-rectangle cells, with a one-billion cell/reference-patch work guard. Reads stream in bounded 512-by-512 windows. Memory, deadline, cancellation, access and source checks remain. Point-cloud calculation limits are unchanged. An explicitly configured lower deployment limit remains effective.

Using the supplied County Road D original DSM and an expanded QA outline, a 32,908,295-cell bounding rectangle completed in 5.511 seconds at approximately 244.7 MB end RSS. The 512-window net volume was 2,081.382452923304 m³; 128-window integration differed by approximately 4.13e-9 m³. This verifies calculation consistency, not field accuracy.

The supplied measurements.json contains the QA feed-pile record, not the rejected Polygon 1 outline. Therefore this is a larger-than-old-limit test, not reproduction of that exact polygon.

## Verification and deployment acceptance

Local focused measurement verification: 383 tests, 381 passed, zero failed, two environment-dependent skips. This includes real isolated-browser editing/profile/download checks and sidebar lifecycle/layout tests. The quick capture produced a valid 800-by-600 PNG (30,694 bytes); decoded pixels and a separately captured report image verified fresh frames, while saved geometry remained unchanged.

Linux build-stage verification: 1,564 tests, 1,534 passed, zero failed, 30 skipped (browser/native/host fixtures unavailable in that build stage). A subsequent tooltip-title-only change passed all 29 inspector tests locally. Build-stage skips do not substitute for exact-runtime checks; release outcome is recorded in the task handoff.

After deploying, verify on the user's browser:

1. Resize and collapse the sidebar, then switch among model, cloud and maps.
2. Confirm saved records appear automatically without creating volume jobs.
3. Rename, hide, edit, insert and delete points; verify unchanged edits retain volume and changed outlines request recalculation.
4. Save a view image and open/print the model report; inspect the actual downloaded image and PDF. Browser download/print behavior can differ from isolated Chromium tests.
5. Open a saved volume, change profile direction/position, reset, and verify the volume stays unchanged.
6. Calculate the previously rejected Polygon 1 and inspect coverage and reference base; retain the outline if limits or source validation fail.

No Operations code or authorization policy was changed. No source dataset is modified by these UI changes.
