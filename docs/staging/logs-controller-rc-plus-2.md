# RC Plus 2 / M4E log-upload acceptance

Beau supplied the RC Plus 2 used with the M4E as the hardware test target and will provision
`DJI_API_KEY_STAGING` as a secret on `ledge-top-logs-staging` in the separate Staging account.
This is permission to develop/test the log app, not firmware or aircraft control work.
Merger owns shared endpoint/Access/credential deployment coordination.

## Current implementation evidence

- Claude's controller pilot is commit `2abf94d5`; Android source/build recipe exist, but no
  APK from that commit or successful install has been verified by this chat.
- It scans candidate shared-storage FlightRecord directories read-only, hashes raw `.txt`
  logs and uploads missing files to a paired local server. Original files are not deleted.
- Its persistent Android JobScheduler task runs on available network at a nominal 15-minute
  period after initial app setup. Android/DJI background scheduling is not an exact timer;
  reboot persistence and unattended completion require actual-device acceptance.
- The default endpoint is local loopback port 8787 for a USB reverse test. The Cloudflare
  Logs bootstrap does not yet implement the device API or DJI decoder. Do not pair the APK
  to that Worker and describe it as working upload/processing.
- A later read-only discovery found the existing SDK at
  `C:\OpenDroneLog\tools\android-sdk` and JDK at `C:\OpenDroneLog\tools\jdk17`.
  Reuse `platform-tools\adb.exe`; it is not on the current shell PATH. The existing shared
  ADB server successfully sees an authorized `DJI_RC_PLUS_2` running Android 11 / API 30.
  Do not stop/restart that shared server or install another toolchain unnecessarily.
- The controller already has `com.opendronelog.sync` version 0.1.0 / code 1000006 installed,
  with a currently running foreground `com.opendronelog.bgsync.SyncService` and registered
  boot receivers. This is a live service observation, not proof it launched from this boot
  or that its endpoint uploaded a log successfully. No app install, reboot, config change,
  log upload, credential extraction or firmware/aircraft command was performed.
- The working older source is `C:\OpenDroneLog\opendronelog-sync` at `28f97fc`
  (`feat: background sync on Android controllers`), with existing untracked `.claude/`.
  Its `TESTING.md` neighbor records prior tests; treat those as historical evidence. Preserve
  this separate checkout, installed app and existing endpoint/pairing while implementing the
  new Ops integration. Do not blindly follow its older uninstall/reinstall instructions.

## Decoder/key boundary

Upstream OpenDroneLog uses `dji-log-parser`; its documented version-13+ flow fetches DJI
keychains using an activated Open API application's key and can persist keychains for
later offline parsing. Do not assume a Mobile SDK app key is equivalent. Verify the chosen
upstream version, license, M4E log-format support, normalized output contract and bounded
keychain request behavior before selecting/integrating it. Keep original raw logs and
encrypted keychains separately from derived telemetry. A successful ODL Parquet import is
not evidence that raw DJI decoding works.

The staging credential remains server-side under the exact name `DJI_API_KEY_STAGING`.
It must never enter the APK, build system, source control, browser or ordinary logs. Do not
read/export its value for a local CLI invocation or use a production-key fallback. Merger
must coordinate a protected server-side decoder/keychain path and separate staging
`KEYCHAIN_ENCRYPTION_KEY`; secret presence alone does not establish a working adapter.

## Encryption requirement

Beau explicitly requires sensitive credentials/key material to be encrypted. Server-side
API and sealing keys belong in Cloudflare Secrets. Persist fetched DJI decryption keychains
only as authenticated AES-GCM ciphertext under the separate staging sealing key; missing
sealing configuration must fail closed, without writing plaintext. Keep that secret separate
from the ciphertext/database/backup and preserve a secure recovery/rotation plan.

For the controller, keep credentials/tokens encrypted under a non-exportable Android
Keystore key; never embed the DJI API key in the APK. The inspected older `Store.kt` source
encrypts both remembered passwords and session tokens using Android Keystore-backed AES-GCM,
and migrates its old plaintext token preference. This source inspection does not prove the
installed APK is exactly that build or that every other storage path is protected. Verify
artifact/signing/source provenance and error/backup/log paths before claiming full acceptance.
No existing credentials or their values were read during this check.

## Hardware test sequence

1. Verify USB device serial/model/Android build using approved platform tools after the
   controller owner authorizes the PC. Inspect installed package identity/signing first;
   do not uninstall an older app or clear its data to bypass signing conflicts.
2. Build/sign a test APK from reviewed source with a stable test signing identity. Verify
   package permissions contain no firmware/root/aircraft-control capability. Do not update
   controller firmware, modify DJI Pilot or send flight commands.
3. Pair only with the reviewed synthetic/local or protected staging endpoint. Confirm
   pairing revocation, wrong-device token denial and bounded upload validation first.
4. With a small selected test-flight log, verify controller SHA-256 equals the accepted raw
   object hash, duplicate attempts create one logical flight and raw originals remain intact.
   Record hashes/statuses, not locations/serials/key material, in shared receipts.
5. Disconnect/reconnect network mid-upload, retry, relaunch the app and reboot the controller
   with the owner's help. Verify boot/background upload behavior without requiring the app
   to stay foreground; record any required DJI battery/startup permission as a limitation.
6. Verify actual raw-log decoding, keychain caching, parser failure/quarantine, telemetry
   attribution and correct pilot/drone association. No automatic attribution from email or
   from a filename; preserve the reviewed paired identity and source log.
7. Revoke the device and prove subsequent upload is denied. Preserve existing files and
   pairing history; let the owner choose whether the test app stays installed.

References: [parser/keychain flow](https://github.com/lvauvillier/dji-log-parser/blob/master/README.md),
[OpenDroneLog](https://github.com/arpanghosh8453/open-dronelog).
