#!/usr/bin/env bash
# Runs inside the pinned incoming-pickup Alpine image.  It verifies the musl
# syscall fallback instead of a host libc symbol, without touching R2.
set -Eeuo pipefail

root=$(mktemp -d /tmp/incoming-pickup-alpine.XXXXXXXX)
cleanup() { rm -rf -- "$root"; }
trap cleanup EXIT

request_id="request-0001"
upload_id="upload-0001"
object_key="quarantine/$request_id/$upload_id/object"
destination="$root/incoming"
staging="$destination/.incoming-staging"
state="$destination/.incoming-state"
race_destination="$destination/$request_id/$upload_id"
delete_log="$root/delete.log"
bin="$root/bin"
mkdir -p -- "$bin"
export request_id upload_id object_key delete_log

# `timeout clamscan` executes an external process, so place only this scanner
# fixture on PATH. aws and curl below are exported Bash functions.
printf '%s\n' '#!/bin/sh' 'mkdir -p -- "$RACE_DESTINATION"' 'exit 0' >"$bin/clamscan"
chmod 700 -- "$bin/clamscan"

aws() {
  case " $* " in
    *" list-objects-v2 "*) printf '%s\n' "{\"Contents\":[{\"Key\":\"$object_key\",\"Size\":4}]}" ;;
    *" head-object "*) printf '%s\n' "{\"ContentLength\":4,\"ETag\":\"\\\"abcd\\\"\",\"Metadata\":{\"requestid\":\"$request_id\",\"originalname\":\"photo.jpg\"}}" ;;
    *" get-object "*) printf 'data' >"${@: -1}" ;;
    *" delete-object "*) : >"$delete_log" ;;
    *) return 1 ;;
  esac
}

curl() { printf '200'; }
export -f aws curl
export RACE_DESTINATION="$race_destination"
export PATH="$bin:$PATH"
export INCOMING_PICKUP_R2_BUCKET="incoming-private"
export INCOMING_PICKUP_R2_ENDPOINT="https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com"
export AWS_ACCESS_KEY_ID="pickup-key"
export AWS_SECRET_ACCESS_KEY="pickup-secret"
export INCOMING_PICKUP_SECRET="pickup-receipt-secret"
export INCOMING_PICKUP_DESTINATION_DIR="$destination"
export INCOMING_PICKUP_STAGING_DIR="$staging"
export INCOMING_PICKUP_STATE_DIR="$state"
export INCOMING_PICKUP_API_BASE="https://incoming.ledgetopdroneservices.com/api/internal/uploads"
export INCOMING_PICKUP_MAX_JOBS="1"

# This is the pinned Alpine/musl regression: its libc intentionally has no
# named wrapper, so a successful worker run necessarily exercises syscall().
python3 - <<'PY'
import ctypes
assert getattr(ctypes.CDLL(None), "renameat2", None) is None
PY

/usr/local/libexec/incoming-pickup-worker.sh --once

test -d "$race_destination"
test -z "$(find "$race_destination" -mindepth 1 -print -quit)"
test -z "$(find "$staging" -mindepth 1 -print -quit)"
test ! -e "$delete_log"
printf '%s\n' 'pinned Alpine no-replace promotion test passed'
