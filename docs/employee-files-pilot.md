# Employee files: isolated Windows pilot

This pilot evaluates Nextcloud with the official Windows desktop client before any production file access or branded client work. Docker runs the local server; employees use a native desktop installer. It does not connect production storage, add SSO, publish to R2, or change the thumbnail service.

**Current result: writable acceptance is blocked.** Eleven independent automated groups pass; the twelfth reproduces a stale-write protection failure. The Windows installer has not been installed and Explorer behavior remains untested. The named pilot containers are stopped at completion; retained volumes and local state allow later diagnosis.

## Known revision blocker

The deterministic regression creates and replaces equal-size content while retaining the exact modification timestamp through `X-OC-Mtime`, then attempts another write with the original `If-Match` ETag. The expected response is `412 Precondition Failed`; the tested server returns `204`, accepting the stale overwrite. The revision probe records that the ETag did not advance. Review of the stable-34 scanner source found an ETag reuse path when `storage_mtime` is unchanged. A newer release has not been verified to fix this.

The test deliberately returns nonzero while this blocker exists. Do not add sleeps, change timestamps to evade it, or weaken the assertion to claim writable acceptance. Personal writable folders exist only for disposable diagnostics. Manual client experiments cannot substitute for fixing or avoiding this server behavior through a separately reviewed design. Acceptance receipts are retained under `apps/employee-files-pilot/.pilot/receipts`; the latest result is `.pilot/acceptance.json` in that same app directory.

## Start the local server

Prerequisites: Node.js and a working Docker installation with Docker Compose. Run these commands from the repository root:

```powershell
node apps/employee-files-pilot/pilot.mjs init
node apps/employee-files-pilot/pilot.mjs up
node apps/employee-files-pilot/pilot.mjs bootstrap
node apps/employee-files-pilot/pilot.mjs test
node apps/employee-files-pilot/pilot.mjs status
```

The local URL is `http://127.0.0.1:18087`. Initialization generates local secrets under ignored `apps/employee-files-pilot/.pilot/secrets`. Synthetic users are `employee-one`, `employee-two`, and the unassigned test user `outsider`; each has a correspondingly named secret file. The separate administrator is `pilot-admin`, whose password is in the `admin` secret file. View credentials locally only when needed; commands do not print them. Do not paste passwords or secret files into issues, commits, screenshots, or chat.

Tracked `apps/employee-files-pilot/images.lock.json` pins official images by immutable digest. Local `.pilot/images.env` must match it exactly; version changes require explicit review. Repeated initialization preserves secrets and does not rotate credentials. If initialized secrets or local state are missing while Docker volumes remain, restore the matching original state instead of generating replacements. Never delete volumes to bypass this guard.

Commands are serialized with `apps/employee-files-pilot/.pilot/command.lock`. If a command crashes, verify its recorded process has exited and that no pilot command is still active before manually removing that lock file. Do not remove an active command's lock or use destructive cleanup as a reset.

Localhost HTTP is only for this synthetic, single-machine experiment. Other computers cannot connect through their own `127.0.0.1`. A real server requires private routing and trusted HTTPS before any live credentials or business files are used; do not expose this test port publicly.

## Connect the Windows client manually

Download **Nextcloud Files** for Windows from the [official download page](https://nextcloud.com/install/#install-clients). Record the installer version, Windows version, server image version, and test date. Install it manually and review the installer publisher. The pilot does not install or alter desktop software automatically.

Add an account using the local URL, complete browser login as `employee-one`, and select virtual files when offered. Use a new, empty local folder that is not managed by another sync product. Do not select Documents, a production project, or an existing Syncthing/OneDrive workspace. Confirm the actual client wording for **Always keep on this device** and **Free up space**; wording may vary by release. See [desktop client usage](https://docs.nextcloud.com/server/stable/user_manual/en/desktop/usage.html).

## Test in two stages

First use only the synthetic **Server Reference** mount exposed to both employees. Verify that employees can browse and fetch it but cannot upload, rename, or delete its contents; `outsider` must neither list nor access it. Never make a live source writable to complete a test. For disposable writable diagnostics only, create a clearly named project in an employee's personal Files area. Use generated text files and a disposable media copy; retain the originals outside the pilot. Sharing is deliberately disabled. Use the same employee account in the desktop client and a separate browser session for conflict diagnostics; do not enable sharing or give one employee access to another's private folder.

Record each result as **pass**, **fail**, or **not tested**, including the exact operation and observed outcome. The CLI's server tests do not establish that Explorer placeholders work; the following checks require a human desktop session.

| Check | Procedure and acceptance evidence |
| --- | --- |
| Read-only source | Try create, rename, overwrite, and delete as each employee. All writes must fail; source content must remain unchanged. |
| Explorer placeholders | Populate the disposable project through the web UI, then inspect it in Explorer. Names and sizes should appear before content is downloaded. Record status icons and **Size on disk**; merely listing a folder should not fetch every file. |
| Download and pin | Open one online-only file and verify content. Pin a project folder, wait for synchronization to finish, then verify every expected file is locally available. Measure local disk use before and after. |
| Free local space | With all changes synchronized, use the client's free-space action on a disposable file. It must remain visible remotely and in Explorer, with local allocation reduced. Reopen it to confirm hydration. Do not use Delete as an eviction action. |
| Offline access | Disconnect only this account's connection or stop the pilot server; avoid disrupting unrelated work. Pinned files must open. An uncached online-only file should report unavailability without becoming a zero-byte file or remote deletion. Reconnect and verify recovery. |
| Offline edits and conflicts | Pin a disposable text file as employee one. Pause or disconnect that desktop client's synchronization while leaving the server available, then edit locally. In a separate browser session signed in as employee one, edit the same remote file. Resume desktop synchronization. Preserve both versions and record conflict behavior. Do not expect automatic merging of binary project files; this diagnostic cannot clear the known revision blocker. |
| Interrupted transfer | Transfer a large disposable media copy, interrupt the server connection, then restore it. Verify completion, matching file size and SHA-256 hash, and absence of a partially published final file. Record peak local and server temporary-disk use. |
| Revocation | With a disposable project cached, disable the connected test employee or revoke its app session as administrator. Confirm subsequent remote reads and writes fail, including after restarting the client. Re-enable only that synthetic test account after recording the result. Already downloaded files may remain readable locally; revocation is not remote wiping. |
| Cache and account safety | Before removing an account or uninstalling, copy any unsynchronized work to a separate folder and verify it. Record which cached files remain after account removal. Never remove `.pilot`, local sync folders, or server volumes while relying on them as the only copy. |
| Delete and restore | Delete a disposable file through Nextcloud, restore it from Deleted files, and verify its content and resynchronization. Separately confirm that a preserved original remains available outside the pilot. |

A second Windows computer requires a separately authorized private HTTPS server stage. Do not widen the localhost listener simply to run the test. The initial conflict diagnostic uses this machine's desktop client and a separate browser session signed in as the same employee.

## Retain, stop, and restore

Stop the pilot with:

```powershell
node apps/employee-files-pilot/pilot.mjs stop
```

Retain the generated configuration, secrets, Docker storage, and recorded results until the review is complete. Stopping is not a backup. Do not run volume deletion or cleanup commands against the pilot until all disposable-versus-retained content has been checked. Nextcloud trash and file versions are useful recovery features with retention limits, not independent backups; test a restore before relying on either. See [deleted-file management](https://docs.nextcloud.com/server/stable/user_manual/en/files/deleted_file_management.html).

## TrueNAS hold and future handoff gates

The user has explicitly placed all TrueNAS access and test-dataset actions on hold. Leave `192.168.50.80` untouched: no connections, deployment, dataset creation, scans, or remote changes. Hermes coordination is for a later handoff.

Future handoff requirements, only after new authorization: resolve writable acceptance, identify an approved copied test dataset and permissions, establish private routing and trusted HTTPS, and agree on snapshots and a verified restore. A proposed first remote stage would be read-only; a writable trial would need a separate disposable dataset and passing acceptance. Do not mount the server root, Docker socket, credentials directory, or a production share into this local pilot.

For any future authorized NAS pilot, direct NAS/SMB changes need explicit index-refresh testing: Nextcloud cannot reliably advertise deep changes that bypass its index. The future design must choose SMB update notifications or scheduled external-storage scans as appropriate, then verify nested create/edit/delete/rename operations. Scan-discovered renames may be treated as deletion plus creation and lose associated Nextcloud metadata. This is a planning requirement, not an instruction to change the held server. See [official external-storage change detection](https://docs.nextcloud.com/server/stable/admin_manual/configuration_files/external_storage_configuration_gui.html#detecting-changes-made-outside-nextcloud).

Production approval requires the manual checks above, realistic media sizes and folder counts, an agreed policy for simultaneous editing, and tested recovery. Server-side locking is not a substitute for an editor's collaboration model. The later shared installer, employee/client role routing, SSO, and authorized R2 delivery remain separate design work; there is no automatic client publication or R2 upload in this pilot.
