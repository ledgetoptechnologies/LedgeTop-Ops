# GCP photo-search default

New GCP workspaces and API requests without a selected mode now use a fixed
50-foot radius (15.24 metres). Explicit Auto radius and Nearest images remain
available. Fixed-radius results do not expand automatically when fewer than
three/five candidates exist; the existing warning remains visible instead.

The radius measures **camera GPS proximity**, not whether the ground-control
target is visible. In-flight photos outside50feet can still contain the target;
Auto or a larger explicit radius can help. Every suggested correspondence still
requires the operator to identify and mark the actual target in the source photo.

Radius state and the API stay in metres. Imperial workspaces show feet; metric
workspaces show metres. The form records the units it rendered so a session
renewal changing display preferences cannot reinterpret an unsubmitted value.
Custom radius values remain authoritative. Fractional metric values such as15.24
use unrestricted numeric stepping, and invalid/zero/oversized values reject.

This change does not implement automatic Emlid CSV discovery, permanent raw-file
retention, full candidate pagination/map browsing, new upload limits or a new GCP
editor. Existing import/provenance/permissions/pixel marking/ODM serialization
are preserved. Those remaining parts of the requested GCP workflow still need
their own implementation and real dataset acceptance.

Validation:25focused tests passed, covering exact unit conversion, API default
and explicit filtering/Auto/Nearest, invalid inputs, actual GCP renderer and form
submission functions, existing Emlid import, source association, marking and
NodeODM snapshot serialization. Renderer tests use light dependency stubs and
are not live-browser acceptance. ExistingVite build passed using reused
dependencies, a384MiB Node heap cap and no new browser/dependency install; its
owned process exited and the temporary dependency junction was removed. Source
review found no actionable issue in the bounded pass. Staging visual/workflow
acceptance and release are pending; no production or data mutation performed.
