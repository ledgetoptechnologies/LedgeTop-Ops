# Controller acceptance results (local NAS mode): template

Copy this file once per run, fill in each field, and keep it with the run's evidence. The steps are defined in
`ACCEPTANCE-LOCAL-LOGS.md` (#601). **Never** write tokens, keys, Access secrets, serial numbers, coordinates or raw log
contents here.

Every result is exactly one of:
- **PASS**: observed, with evidence;
- **FAIL**: observed, with what happened;
- **NOT RUN**: not attempted, with the reason.

A step that was not observed is never PASS.

## Run

| Field | Value |
| --- | --- |
| Date and time (UTC) | |
| Run by | |
| Approved by (Merger) | |
| Environment | Staging only (dedicated Logs container and route) |
| Controller model | |
| Controller firmware / Android version | |
| Lock screen on the controller? (none / PIN / other) | |
| APK version (`BuildInfo.VERSION`) and its source commit | |
| Test log used (approved copy; name only) | |

## Source and deployment revisions

| Part | Expected | Actually deployed |
| --- | --- | --- |
| Public device proxy (#596) | `26209f70` | |
| NAS Logs host image digest (`image@sha256:…`) and its stamp revision | `keyless` | |
| NAS packaging (#593) | `de2266b2` | |
| Ops (combined candidate incl. #590/#591/#595) | as admitted by Merger | |
| Admin review backend / UI (#599 / #603) | `b3062ec8` / `f839cb3e` (if deployed) | |
| Public host settings present (names only) | `LOGS_DEVICE_UPSTREAM_MODE=local`, `LOGS_DEVICE_PUBLIC_HOSTS`, device-proxy token | |
| DJI key on the NAS | blank (keyless pilot) | |

## Results

| # | Step (see #601) | Result | Evidence (screenshot/status names, counts, times; no secrets) | Notes |
| --- | --- | --- | --- | --- |
| 1 | Sign in: username typed, approved in Ops, controller shows "Signed in" | | | |
| 2 | Keyless upload: admin status shows received +1 and waiting with reason "waiting for the DJI key"; no failure | | | |
| 3a | Reboot without opening the app: auto sign-in, no sign-in asked | | | |
| 3b | Reboot without opening the app: new log uploaded within minutes (`lastBootAction` = BOOT_COMPLETED, `lastSync` after boot) | | | |
| 3c | An unlock was needed before the upload (yes/no) | | | |
| 4a | NAS container stopped: controller says "will retry", stays signed in, log stays queued | | | |
| 4b | Logs **test route only** cut mid-upload (approved fault injection, never the shared Tunnel): still signed in, log queued | | | |
| 5 | Recovery (container and isolated route restored): queue drains, each log counted once | | | |
| 6 | Device revoked in Ops: next sync asks to sign in again; nothing more accepted | | | |
| 7 | Reboot after revocation: no upload, sign-in prompt still shown | | | |

## Ops admin checks during the run (administrator account)

| Check | Result | Notes |
| --- | --- | --- |
| Review banner shows "received", "waiting for the DJI key", and no false "stored" for missing originals | | |
| No home position, track or raw content is visible in the review lists | | |
| Controller list shows the device as signed in, then signed out after step 6 | | |
| Audit log has the sign-in approval and the revocation | | |

## Not covered by this run

- Real decoding with a DJI key: a separate acceptance.
- History import (#598) and the export Worker (#600).
- Production: staging only.

## Outcome

- [ ] All steps PASS: the APK works against the NAS on this controller (record its model and firmware above).
- [ ] Any FAIL or NOT RUN: list each one with its follow-up owner:

