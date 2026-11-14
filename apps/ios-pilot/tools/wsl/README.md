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

- `ios-pmd.sh <args>`: pymobiledevice3 from the toolchain venv, pointed at the
  relay socket. `syslog live -m "webshell "` shows the shell's state lines.

Install in place with `ios-run.sh xtool install --usb xtool/LTOpsPilot.app`.
Install the unsigned `.app`: xtool adds the `XTL-<team>.` prefix once while
signing, which matches the copy already on the iPad. If the first attempt ends
with "no current IOS devices on this team", run it again; the first attempt
registers the device. Afterwards check `ideviceinstaller -l` shows one pilot app.

The Apple account is on free provisioning, so each install stops opening after
7 days and must be reinstalled.

## Unattended device check

Needs the iPad unlocked and awake (set Auto-Lock to Never while testing), the
relay running, and the developer disk image mounted
(`ios-pmd.sh mounter auto-mount`, once per iPad restart).

1. `ios-tunnel.sh start` opens the developer tunnel (`stop` when finished).
2. `ios-shelltest.sh <screenshot.png> [wait] [retry]` launches the pilot with
   `-LTOpsOpenWebShell YES`, waits, and saves a screenshot. `retry` keeps trying
   for that many seconds while the iPad is locked.
3. `ios-pmd.sh syslog live -pn LTOpsPilot` piped through `grep webshell` shows
   each page the shell loaded, dropped or blocked.
