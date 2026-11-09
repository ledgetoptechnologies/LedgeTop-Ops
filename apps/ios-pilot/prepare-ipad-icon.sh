#!/usr/bin/env bash
# Run on the Linux build copy after `xtool dev build` and before signing or
# `xtool install`: editing a signed app invalidates its signature.
set -euo pipefail
cd "$(dirname "$0")"
app=xtool/LTOpsPilot.app
catalog=Resources/Assets.xcassets
sdk_root="${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/swiftpm}"
sdk_root="${sdk_root:-$HOME/.swiftpm}/swift-sdks/darwin.artifactbundle"
actool="${ACTOOL:-$sdk_root/Developer/Platforms/iPhoneOS.platform/Developer/usr/bin/actool}"
test -f "$app/Info.plist" && test -d "$catalog" && test -x "$actool"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$actool" "$catalog" --compile "$app" --platform iphoneos --app-icon AppIcon \
  --minimum-deployment-target 17.0 --output-partial-info-plist "$tmp/icon.plist" \
  --output-format human-readable-text
python3 - "$app/Info.plist" "$tmp/icon.plist" <<'PY'
import plistlib, sys
path, partial = sys.argv[1:]
with open(path, 'rb') as f: info = plistlib.load(f)
with open(partial, 'rb') as f: info.update(plistlib.load(f))
with open(path, 'wb') as f: plistlib.dump(info, f, fmt=plistlib.FMT_BINARY)
PY
test -s "$app/Assets.car" && test -s "$app/AppIcon76x76@2x~ipad.png"
