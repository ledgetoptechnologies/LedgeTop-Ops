#!/usr/bin/env bash
# Runs pymobiledevice3 from the toolchain venv.
export PATH=/opt/ltops-apple-dev/home/pymobile3-venv/bin:/opt/ltops-apple-dev/usrlocal/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export USBMUXD_SOCKET_ADDRESS=/var/run/usbmuxd
cd /root
exec pymobiledevice3 "$@"
