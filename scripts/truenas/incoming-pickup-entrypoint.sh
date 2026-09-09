#!/usr/bin/env bash
set -Eeuo pipefail

: "${INCOMING_PICKUP_REFRESH_SIGNATURES:=1}"
worker_mode="${1:---once}"
if [[ "$worker_mode" == "--pickup-only" ]]; then
  # Verified downloads do not invoke ClamAV; their proof and SHA-256 identity
  # were established by --verify-only and are rechecked before local write.
  :
elif [[ "$INCOMING_PICKUP_REFRESH_SIGNATURES" == "1" ]]; then
  # A failed signature refresh is fail-closed: clamscan must not promote with
  # stale or missing definitions.  The scheduled run can retry next hour.
  timeout --signal=TERM --kill-after=15s 120 freshclam --stdout --datadir /var/lib/clamav
elif [[ "$INCOMING_PICKUP_REFRESH_SIGNATURES" != "0" ]]; then
  echo "incoming-pickup fatal: INCOMING_PICKUP_REFRESH_SIGNATURES must be 0 or 1" >&2
  exit 2
fi

exec /usr/local/libexec/incoming-pickup-worker.sh "$@"
