#!/usr/bin/env bash
set -Eeuo pipefail

: "${LTDSTHUMB_WORKER_CONCURRENCY:=4}"
: "${LTDSTHUMB_SCRATCH_DIR:=/scratch}"
[[ "$LTDSTHUMB_WORKER_CONCURRENCY" =~ ^[0-9]+$ ]] &&
  (( LTDSTHUMB_WORKER_CONCURRENCY >= 1 && LTDSTHUMB_WORKER_CONCURRENCY <= 8 )) || {
    echo "fatal: LTDSTHUMB_WORKER_CONCURRENCY must be an integer from 1 through 8" >&2
    exit 2
  }
[[ "$(stat -f -c '%T' -- "$LTDSTHUMB_SCRATCH_DIR" 2>/dev/null || true)" == "tmpfs" ]] || {
  echo "fatal: LTDSTHUMB_SCRATCH_DIR must be a tmpfs RAM mount" >&2
  exit 2
}

pids=()
stop() {
  for pid in "${pids[@]:-}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]:-}"; do wait "$pid" 2>/dev/null || true; done
}
trap stop INT TERM EXIT

echo "thumbnail queue renderer started (slots=$LTDSTHUMB_WORKER_CONCURRENCY, scratch=tmpfs)" >&2
for (( slot=1; slot<=LTDSTHUMB_WORKER_CONCURRENCY; slot+=1 )); do
  slot_dir="$LTDSTHUMB_SCRATCH_DIR/slot-$slot"
  mkdir -p -- "$slot_dir"
  chmod 700 -- "$slot_dir"
  LTDSTHUMB_WORKER_SLOT="$slot" LTDSTHUMB_SCRATCH_DIR="$slot_dir" \
    /scripts/thumbnail-queue-worker.sh &
  pids+=("$!")
done
touch "$LTDSTHUMB_SCRATCH_DIR/worker-ready"

set +e
wait -n "${pids[@]}"
status=$?
set -e
echo "thumbnail queue renderer stopped because one slot exited (status=$status)" >&2
exit "$status"
