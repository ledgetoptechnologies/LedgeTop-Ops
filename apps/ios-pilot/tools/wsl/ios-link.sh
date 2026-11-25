#!/usr/bin/env bash
# start|stop|status the task-owned usbmuxd relay (WSL unix socket -> Windows Apple Mobile Device Service).
export PATH=/opt/ltops-apple-dev/usrlocal/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LD_LIBRARY_PATH=/opt/ltops-apple-dev/usrlocal/lib
PY="$2"; RELAY="$3"; PIDF=/run/claude-ios-relay.pid
case "$1" in
  start)
    [ -f $PIDF ] && kill "$(cat $PIDF)" 2>/dev/null; rm -f /var/run/usbmuxd
    printf '#!/bin/sh
exec "%s" "%s"
' "$PY" "$RELAY" > /root/claude-ios-relay-exec.sh; chmod +x /root/claude-ios-relay-exec.sh
    setsid socat UNIX-LISTEN:/var/run/usbmuxd,fork,mode=666 EXEC:/root/claude-ios-relay-exec.sh >/tmp/claude-ios-relay.log 2>&1 &
    echo $! > $PIDF; sleep 1; ls -la /var/run/usbmuxd ;;
  stop)
    [ -f $PIDF ] && kill "$(cat $PIDF)" 2>/dev/null; pkill -f "UNIX-LISTEN:/var/run/usbmuxd" 2>/dev/null; rm -f $PIDF /var/run/usbmuxd; pgrep -af "UNIX-LISTEN:/var/run/usbmuxd" || echo "relay stopped" ;;
  status)
    pgrep -af "UNIX-LISTEN:/var/run/usbmuxd" || echo "no relay"; timeout 20 idevice_id -l; echo "idevice_id exit $?"; cat /tmp/claude-ios-relay.log 2>/dev/null | tail -5 ;;
esac
