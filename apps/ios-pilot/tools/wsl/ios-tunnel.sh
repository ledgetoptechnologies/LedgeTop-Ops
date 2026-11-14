#!/usr/bin/env bash
# start|stop|rsd: a task-owned developer tunnel to the iPad; `rsd` prints "HOST PORT".
export PATH=/opt/ltops-apple-dev/home/pymobile3-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export USBMUXD_SOCKET_ADDRESS=/var/run/usbmuxd PYTHONUNBUFFERED=1
OUT=/tmp/claude-ios-tunnel.out
case "$1" in
  start)
    pkill -f "lockdown start-tunnel" 2>/dev/null; sleep 1; : > $OUT
    setsid pymobiledevice3 lockdown start-tunnel --script-mode > $OUT 2>&1 &
    for i in $(seq 1 30); do [ -s $OUT ] && break; sleep 1; done; cat $OUT ;;
  rsd) grep -E "^[0-9a-f:]+ [0-9]+$" $OUT | tail -1 ;;
  stop) pkill -f "lockdown start-tunnel" 2>/dev/null; sleep 1; pgrep -af "start-tunnel" || echo "tunnel stopped" ;;
esac
