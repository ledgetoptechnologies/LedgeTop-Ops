# Point-cloud display controls

Scope: display settings only. Orbit, pan, zoom, viewpoint continuity, measurements, camera overlays and source data are not changed by the display reset.

- **Reset display to defaults** restores a 10-million-point target (existing adaptive performance budget remains active), size 1, fixed sizing, RGB, EDL shading on, and automatic elevation color bounds.
- Fixed sizing is enforced by the iframe API as well as the parent. The alternate sizing-mode selector is removed; the scalar Size slider remains.
- The color menu offers RGB, Elevation and Classification. Intensity is no longer offered; stale unsupported API color values fall back to RGB.
- Elevation uses two independently keyboard-focusable native thumbs on one track, alongside the existing typed Min/Max fields. Both update colors live, without clipping points. Invalid or crossed ranges retain the last valid rendering. The elevation-only auto reset remains available.
- Classification mode shows an unobtrusive bottom-right readout after the pointer settles. It reads the picked point's decoded classification attribute, not RGB, location or an inferred object type. Unclassified data is labeled as such, absent data is unavailable, and unknown codes retain their numeric value.
- EPT source schema is checked because Potree's geometry adapter declares classification even for absent dimensions. A default buffer must not be presented as authoritative source classification.
- Legacy codes 8 and 12 are qualified because their meaning differs by LAS format/version. The readout does not promise that a ground-only/unclassified photogrammetry dataset contains building or vegetation labels.
- Optional GPU picks are debounced for 180 ms after motion and skipped during dragging, inertia, touch input, measurement insertion, hidden tabs, or other color modes. Five-pixel picks use only visible decoded nodes. Leaving the canvas, scrolling, changing mode, blur and page hiding cancel pending work and clear stale text. No new point/photo downloads are triggered by the readout.
- Optional pick failures restore the render material/state. Potree's per-pick User Timing entries are cleared unless its explicit timing mode is enabled, avoiding retained hover timing history.

## Verification

Focused automated checks: `node --test test/point-cloud-display.test.js test/point-cloud-elevation.test.js test/point-cloud-wiring.test.js`.

Visual and interaction harness: `node test/helpers/point-cloud-display-preview.mjs`. This uses the shipped HTML, CSS, sidebar bindings and hover scheduler with synthetic decoded values; it is not evidence of GPU pick correctness or live EPT performance.

Manual acceptance on a classified production cloud: select Classification; pause over known ground, vegetation and building points; verify decoded class names/codes. Empty canvas clears the value. Orbit, pan and zoom must remain responsive with no picking during movement. Then use both elevation thumbs with mouse and keyboard, edit typed bounds, change units, and reset display; viewpoint, existing measurements and camera overlay visibility must remain unchanged.

Implementation references: [Potree 1.8.2 decoded pick attributes](https://github.com/potree/potree/blob/1.8.2/src/PointCloudOctree.js), [EPT geometry metadata](https://github.com/potree/potree/blob/1.8.2/src/PointCloudEptGeometry.js), and [ASPRS LAS specifications](https://github.com/ASPRSorg/LAS).
