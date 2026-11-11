#!/bin/sh
# Disposable fixture only; never run on a Viewer data mount.
set -eu
root=$(mktemp -d "${TMPDIR:-/tmp}/viewer-noreplace.XXXXXXXX")
trap 'rm -rf -- "$root"' EXIT
trap 'exit 1' HUP INT TERM
cc -std=c11 -Wall -Wextra -Werror -O0 "$(dirname "$0")/rename-noreplace-fixture.c" -o "$root/probe"
mkdir "$root/data"
"$root/probe" "$root/data"
