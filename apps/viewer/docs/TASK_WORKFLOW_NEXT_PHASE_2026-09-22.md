# Task workflow and survey comparison — 2026-09-22

## Current implementation batch

- Select from PC directly opens the browser image picker. A compact folder action opens the separate recursive directory picker; browsers do not offer a portable combined picker. Cancelling preserves selected files.
- Recorded photo GPS locations load automatically after selection, with cancellation/debounce for changed selections and dialog closure. Missing EXIF coordinates are reported, never invented.
- Wider responsive dialog and taller map; existing Viewer Esri imagery endpoint reused with attribution, anonymous CORS and a plain-background option. External imagery is context, not survey data. No new paid service or account configured; availability/licensing is not guaranteed by a public endpoint.
- Capability-driven task overrides expose supported node options with inherited preset/default values, typed inputs, search, and false/zero preservation. Required Viewer outputs stay enabled. Arbitrary file/path options are not accepted through this editor.
- Report printing waits for image decoding and fonts and still requires an explicit click. A failed image retains printable measurement tables with a warning.

The supplied measured-view PNGs confirm actual downloads with measurement overlays. The supplied two-page PDF contains the captured view and all five measurement rows, including Polygon 1 (net 208,355.048 ft³). This checks export completeness, not ground-truth survey accuracy.

## Separate features still requiring implementation / acceptance

### Presets and processing

The existing preset API supports CRUD and immutable effective attempt options. The admin preset editor is still JSON-based. Add a guided editor/import screen using the same capability-driven controls, with explicit enabled values; a copied list of all available WebODM flags is not a selected preset. Preserve the original source photos. Optional image resizing, reconstruction-boundary authoring/staging, and GCP workflows are separate from the GPS preview.

A representative small raw-photo dataset is needed for an authorized real-node end-to-end run. Browser fixtures must not launch actual processing. Check image counts, server-copy recursion, names, GPS preview, effective options, processing outputs and original provider report.

### Multi-date comparison

Implement same-project survey/date selection and two independently authorized output versions. First deliver a shared 2D map viewport with orthophoto overlay opacity or swipe. Handle loading failure/revocation independently; do not broaden client permissions or expose another person's measurements. Keep measurements tied to their actual survey/version; same-project membership does not make them interchangeable.

Validate CRS and overlap before showing comparison. Same CRS or apparent overlap does not establish accurate registration. Elevation/volume differences require confirmed units, datum and alignment quality. Structured survey dates should not be inferred permanently from display names.

### Processing alignment (not merely an overlay)

ODM supports registered alignment reference LAS/LAZ or single-band TIFF; automatic alignment is documented as experimental. Current Viewer auxiliary file handling does not safely implement this contract: TIFF could be treated as a photograph. Add an explicit authorized reference-output role, immutable source identity/hash and coordinate metadata, approved staging name, retry reproducibility and TIFF-not-photo tests before exposing Alignment.

Do not send arbitrary server paths through an `align` text option. Do not silently align a new survey to whichever existing survey is first in the project.

### Reports

Retain original processing quality report as its own download. The personal measurement report is a separate deliverable containing user-owned annotations and calculated results; neither substitutes for the other.

## References

- Browser directory picker: https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory
- Node capabilities/options API: https://github.com/OpenDroneMap/NodeODM/blob/master/docs/index.adoc
- ODM alignment: https://docs.opendronemap.org/align/
- Esri basemap usage/account terms: https://developers.arcgis.com/rest/basemap-styles/

No Operations repository code was modified for this batch.

## Verification evidence

- Production Vite build passed.
- Linux full suite: 1,611 total, 1,580 passed, 31 skipped, zero failures; retained container `viewer-options-full-tests-20260922`, exit 0. The skipped browser cases are not counted as live acceptance.
- Windows browser measurement suite: 3 passed, zero skips; real measured PNG (30,694 bytes) and browser print-backend PDF (44,651 bytes). Native host print-dialog interaction remains a separate check.
- Focused report/options/photo-map tests: 28 passed. Preset CRUD and task submission integration tests also passed.
- New Task browser regression exercises picker activation/cancel, automatic GPS, stale requests, retry, false/zero options, locked outputs, late folder browsing and capability drift; no actual processing node jobs were launched.
- Satellite tile delivery is not verified by the isolated browser fixtures. Failure to load the background must not affect EXIF marker positions or source selection.
