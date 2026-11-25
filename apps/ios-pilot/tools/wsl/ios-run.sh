#!/usr/bin/env bash
# Runs a command in WSL with the Apple toolchain on PATH, from the build copy.
export PATH=/opt/ltops-apple-dev/swift-6.4.0/usr/bin:/opt/ltops-apple-dev/usrlocal/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /root/claude-ios-app/ios-pilot 2>/dev/null || cd /root
exec "$@"
