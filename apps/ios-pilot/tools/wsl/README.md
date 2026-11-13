# Building and installing from Windows through WSL

Helper scripts used on Beau's PC (WSL Ubuntu-24.04 with the toolchain under
`/opt/ltops-apple-dev` and xtool already signed in). Run each with
`wsl -d Ubuntu-24.04 -- bash <script>`; do not inline `$PATH` in a `wsl` command
line, because the Windows PATH is expanded into it and breaks the shell.

- `ios-run.sh <command...>`: runs a command with the toolchain on PATH from the
  build copy `~/claude-ios-app/ios-pilot`.
- `ios-link.sh start <windows python.exe as /mnt/c path> <C:/.../amds_relay.py>`,
  `status`, `stop`: a task-owned relay from the WSL usbmuxd socket to the Windows
  Apple Mobile Device Service (127.0.0.1:27015) via `amds_relay.py`. No admin
  rights or usbipd needed. Always `stop` when finished.
- `ios-build-shelltest.sh`: copies the `ios-app-claude` worktree into WSL, turns
  the web shell on for a local test allowlist in the build copy only, and builds
  unsigned.

Install in place with `ios-run.sh xtool install --usb xtool/LTOpsPilot.app`.
Install the unsigned `.app`: xtool adds the `XTL-<team>.` prefix once while
signing, which matches the copy already on the iPad. If the first attempt ends
with "no current IOS devices on this team", run it again; the first attempt
registers the device. Afterwards check `ideviceinstaller -l` shows one pilot app.

The Apple account is on free provisioning, so each install stops opening after
7 days and must be reinstalled.
