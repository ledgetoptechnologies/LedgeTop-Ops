# Controller acceptance: Logs served from the NAS (local mode)

This is a physical test checklist for the controller APK once the public Logs host forwards the device API to the NAS
Logs host. Nothing here has been run yet. Each result must be recorded with the date, controller model and firmware,
APK version, and the source revisions below.

## Source revisions under test

| Part | Revision |
| --- | --- |
| APK (`apps/logs-controller`) | main `fe97917c` |
| Public device proxy (#596) | `26209f70` |
| NAS Logs host and keyless decoder (#592) | merged in main `fe97917c` |
| NAS packaging (#593) | `de2266b2` |
| Admin status / review backend (#599) | `b3062ec8` (status counts for step 2) |

Record the exact revisions deployed if they differ.

## What the source shows, and what only the device can prove

From reading the source (no build, no device):

- **Token storage.** `TokenVault` encrypts the device token with AES-256-GCM. The key is generated inside the
  Android Keystore and cannot be exported. Only `iv:ciphertext` is stored, and `allowBackup="false"`.
- **Boot.** `BootReceiver` runs on `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`. It schedules the periodic sync and
  an immediate one, using the stored sign-in, so nothing has to be typed again.
- **Upload failures.** Only a 401 from the device API drops the sign-in. Other failures (503, timeouts) keep the
  logs queued for a retry.
- **Routes.** Every call the APK makes (`have`, `sign-in`, `sign-in/<id>`, `logs/<sha>?name=`, `sign-out`) is
  inside the six-route contract the proxy forwards.

Only the device can prove these. **Physical evidence is required for each:**

- **Start after boot.** The app is not `directBootAware`. `BOOT_COMPLETED` is delivered after the first user
  unlock, and the Keystore key is usable from then on. The Keystore key has no user-authentication requirement, but
  that alone does **not** prove the app starts before the first unlock. Whether the controller unlocks by itself
  (no lock screen), and whether the RC firmware delivers `BOOT_COMPLETED` to side-loaded apps or restricts
  background start, must be observed on the controller.
- **Outage behaviour.** The proxy turns the classified failures it was tested with into 503 + Retry-After: Access
  service rejection, redirects, edge 5xx/52x/530, non-JSON or code-less answers, and timeouts. That does **not**
  prove a NAS outage can never sign a controller out. Real streaming and proxy behaviour still needs the negative
  tests in steps 4 and 5.

## Scope and safety

- Run every step only against the **dedicated staging** Logs container and its own route, with admitted test files.
  No flying is needed: copy an approved test `DJIFlightRecord` onto the controller.
- **Never** stop the shared staging `cloudflared` or any other ingress, and never cause a production outage. Outage
  steps use Merger-approved, route-specific fault injection (e.g. disabling only the Logs test route, or an isolated
  test proxy that can be disconnected).

## Preconditions (infrastructure owner)

- The NAS Logs host is running keyless, with a blank DJI key.
- The public host is set to `LOGS_DEVICE_UPSTREAM_MODE=local`, with `LOGS_DEVICE_PUBLIC_HOSTS` and the
  device-proxy service token configured.
- An Ops admin account is available to watch the flight-log status.

## Steps

1. **Sign in.** Install the APK and enter a pilot username, then approve the request in Ops.
   *Pass:* the controller shows "Signed in", and Ops lists the device.
2. **Upload while keyless.** Copy one approved test `DJIFlightRecord` onto the controller and let it sync.
   *Pass:* the admin status shows retained +1 and waiting +1, with the reason `waiting_for_key`, and no failure.
3. **Auto sign-in and upload on boot.** Add another log, then power the controller off and on **without opening
   the app**.
   *Pass:* within a few minutes of the network coming up, the log is uploaded. Afterwards, opening the app shows a
   recent `lastSync` and boot action `BOOT_COMPLETED`, and no sign-in was asked for. Record whether the controller
   needed an unlock first.
4. **NAS outage.** Stop the NAS Logs container and add a log.
   *Pass:* the controller says it will retry, stays signed in, and keeps the log queued.
   Then, mid-upload of a large approved test log, cut **only the Logs test route** with the approved fault injection
   (never the shared Tunnel), and repeat.
   *Pass:* still signed in, the log still queued.
5. **Recovery.** Start the container again and restore the isolated test route.
   *Pass:* the queue drains, and the admin status counts each log once (no duplicates).
6. **Revocation.** Revoke the device in Ops.
   *Pass:* on the next sync the controller asks to sign in again, and nothing more is accepted from it.
7. **Reboot after revocation.** Reboot the controller.
   *Pass:* it does not upload, and still shows the sign-in prompt.

## Not covered here

- Real decoding with a DJI key: that is a separate acceptance.
- The admin review screen (PR8) and the history import (#598).
