#!/usr/bin/env bash
# Unattended device check: launch the pilot straight into the web workspace, wait, screenshot.
# Usage: ios-shelltest.sh <screenshot path> [wait seconds] [retry seconds while locked] [launch arguments]
export PATH=/opt/ltops-apple-dev/home/pymobile3-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export USBMUXD_SOCKET_ADDRESS=/var/run/usbmuxd PYTHONUNBUFFERED=1
SHOT="$1"; WAIT="${2:-10}"; RETRY="${3:-0}"; ARGS="${4--LTOpsOpenWebShell YES}"
RSD=$(grep -E "^[0-9a-f:]+ [0-9]+$" /tmp/claude-ios-tunnel.out | tail -1)
[ -n "$RSD" ] || { echo "no tunnel; run ios-tunnel.sh start"; exit 2; }
APP="XTL-9G7886LLK4.com.ledgetoptechnologies.ops.pilot"
# Relaunching over a foreground copy leaves a black scene, so end it first and let the home screen return.
pymobiledevice3 developer dvt pkill --rsd $RSD LTOpsPilot >/dev/null 2>&1; sleep 3
END=$(( $(date +%s) + RETRY ))
while true; do
  OUT=$(pymobiledevice3 developer dvt launch --rsd $RSD "$APP $ARGS" 2>&1)
  echo "$OUT" | grep -q "Failed to launch" || { echo "launched"; break; }
  [ "$(date +%s)" -ge "$END" ] && { echo "launch failed (iPad locked or asleep?)"; exit 1; }
  sleep 5
done
sleep "$WAIT"
pymobiledevice3 developer dvt screenshot --rsd $RSD "$SHOT" >/dev/null 2>&1 && echo "screenshot $SHOT"
