# ltds-dji-decode (local test tool)

Decodes raw DJI flight logs with the MIT-licensed `dji-log-parser` 0.5.7 and prints one JSON summary per
file. It's for checking decoding locally before the Worker adapter: aircraft, battery, duration, height,
photo and video counts, and whether a v13+ log's keychains can be fetched.

- **Key:** set `LTDS_DJI_API_KEY` in the environment only for the run. On Beau's PC the local test key is
  stored DPAPI-encrypted at `%LOCALAPPDATA%\LedgeTop\DJI\dji-open-api-dev.dpapi`. Never print, commit or
  put it in an APK, and never use the staging or production Worker keys here.
- **Output** never includes the key, keychains or full serial numbers (last 4 characters only).
- **Build:** `cargo build --release`, using a separate `CARGO_HOME` and `CARGO_TARGET_DIR` outside the repo.

Photo counts come from two sources: `header.captureNum` (the log's own summary) and `photosFromFrames`
(starts of `camera.is_photo` runs in the ~10 Hz telemetry). Fast interval shooting merges in the
telemetry, so the frame count undercounts.
