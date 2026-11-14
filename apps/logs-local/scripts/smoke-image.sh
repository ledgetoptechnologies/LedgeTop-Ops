#!/usr/bin/env bash
# CI only: smoke-test one exact image digest before any moving tag points at it.
#   smoke-image.sh <image@sha256:digest> <commit> <target>
# Every container is bounded (1 CPU, 1 GiB memory = swap, 256 pids, no network, read-only root, 120 s) and named by
# this run; an EXIT trap removes the owned containers and the temporary data folder on success, failure or cancel.
set -euo pipefail
ref="$1" commit="$2" target="$3"
[[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "smoke: an exact digest reference is required" >&2; exit 2; }
run_id="logs-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}"
data="$(mktemp -d)"
cleanup() {
  for name in "${run_id}-stamp" "${run_id}-user" "${run_id}-start"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  sudo rm -rf -- "$data" || true
}
# EXIT always cleans up; an interrupt or termination also ENDS the script (130/143), so it can never continue
# to later checks or to the promotion step.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
limits=(--cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 --network none --read-only --tmpfs /tmp:size=8m)

timeout 300 docker pull "$ref"
timeout 120 docker run --rm --name "${run_id}-stamp" "${limits[@]}" --entrypoint node "$ref" apps/logs-local/src/build-stamp.mjs check "$commit" "$target"
test "$(timeout 120 docker run --rm --name "${run_id}-user" "${limits[@]}" --entrypoint id "$ref" -u)" = "568"
sudo chown 568:568 "$data"
set +e
timeout 120 docker run --rm --name "${run_id}-start" "${limits[@]}" -v "${data}:/data" "$ref"
code=$?
set -e
test "$code" = "78" || { echo "smoke: first start exited ${code}, expected 78 (not ready, blank config written)" >&2; exit 1; }
sudo test -f "${data}/flight-logs/config/logs.env"
test "$(sudo stat -c '%a' "${data}/flight-logs/config/logs.env")" = "600"
echo "smoke: ok ${ref}"
