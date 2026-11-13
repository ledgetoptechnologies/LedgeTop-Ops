#!/usr/bin/env bash
# Device-test build: copies the worktree, turns the web shell on for a local test allowlist
# (build copy only; the repository keeps it off), builds unsigned.
set -euo pipefail
export PATH=/opt/ltops-apple-dev/swift-6.4.0/usr/bin:/opt/ltops-apple-dev/usrlocal/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SRC="/mnt/c/Projects/Ledge Top Operations/ios-app-claude/apps/ios-pilot"
DST="$HOME/claude-ios-app/ios-pilot"
mkdir -p "$DST"
find "$DST" -mindepth 1 -maxdepth 1 ! -name .build -exec rm -rf {} +
cp -r "$SRC/." "$DST/"
cd "$DST"
python3 - <<'PY'
import plistlib
p='Info.plist'; d=plistlib.load(open(p,'rb'))
d['LTOpsWebShellEnabled']=True
d['LTOpsWebShellOrigins']=['https://ops-staging.ledgetopdroneservices.com']
d['LTOpsWebShellSignInHost']='ledgetoptechnologies.cloudflareaccess.com'
plistlib.dump(d,open(p,'wb'))
print({k:v for k,v in d.items() if k.startswith('LTOps')})
PY
xtool dev build 2>&1 | grep -vE '^\[[0-9]+ / [0-9]+\]' | tail -15
plistutil -i xtool/LTOpsPilot.app/Info.plist 2>/dev/null | grep -A4 -E "LTOpsWebShell|CFBundleIdentifier|CFBundleVersion" | head -30 || true
