#!/usr/bin/env bash
# CI only: smoke-test one exact image digest before any moving tag points at it.
#   smoke-image.sh <image@sha256:digest> <commit> <keyless|full>
# Every container is bounded (1 CPU, 1 GiB memory = swap, 256 pids, no network, read-only root, timeouts) and named by
# this run; cleanup runs on EXIT, and an interrupt or termination ENDS the script (130/143), so it can never continue
# to later checks or to the promotion step. Synthetic configuration only: no real credentials, key or client data.
# This proves the image starts and behaves as packaged; it does NOT prove real DJI decoding.
set -euo pipefail
ref="$1" commit="$2" target="$3"
[[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "smoke: an exact digest reference is required" >&2; exit 2; }
[[ "$target" == keyless || "$target" == full ]] || { echo "smoke: target must be keyless or full" >&2; exit 2; }
run_id="logs-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}"
data="$(mktemp -d)"
names=("${run_id}-stamp" "${run_id}-user" "${run_id}-probe" "${run_id}-parser" "${run_id}-hash" "${run_id}-start" "${run_id}-run")
cleanup() {
  for name in "${names[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
  sudo rm -rf -- "$data" || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
limits=(--cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 --network none --read-only --tmpfs /tmp:size=8m)
parser=/usr/local/bin/ltds-dji-decode

timeout 300 docker pull "$ref"
# 1. The stamp names this exact commit and target.
timeout 120 docker run --rm --name "${run_id}-stamp" "${limits[@]}" --entrypoint node "$ref" apps/logs-local/src/build-stamp.mjs check "$commit" "$target"
# 2. Runs as the app user.
test "$(timeout 120 docker run --rm --name "${run_id}-user" "${limits[@]}" --entrypoint id "$ref" -u)" = "568"
# 3. The native parser. A positive probe answers present (exit 3) or absent (exit 0); any other result, including a
#    timeout or a daemon error, fails the smoke. Keyless must be absent; full must be present AND runnable (no arguments
#    -> its usage exit code 2, which needs every shared library to resolve).
set +e
timeout 60 docker run --rm --name "${run_id}-probe" "${limits[@]}" --entrypoint node "$ref" \
  -e "try { process.exit(require('fs').lstatSync('${parser}').isFile() ? 3 : 4) } catch (e) { process.exit(e.code === 'ENOENT' ? 0 : 5) }"
probe_code=$?
set -e
if [[ "$target" == keyless ]]; then
  test "$probe_code" = "0" || { echo "smoke: keyless parser probe exited ${probe_code}, expected 0 (proven absent)" >&2; exit 1; }
else
  test "$probe_code" = "3" || { echo "smoke: full parser probe exited ${probe_code}, expected 3 (present)" >&2; exit 1; }
  set +e
  timeout 60 docker run --rm --name "${run_id}-parser" "${limits[@]}" --entrypoint "$parser" "$ref"
  parser_code=$?
  set -e
  test "$parser_code" = "2" || { echo "smoke: the parser did not load and run (exit ${parser_code}, expected 2)" >&2; exit 1; }
  # Its SHA-256, for the receipt that is written BEFORE any moving tag (same ownership, caps and cleanup).
  parser_sha="$(timeout 60 docker run --rm --name "${run_id}-hash" "${limits[@]}" --entrypoint sha256sum "$ref" "$parser" | cut -d' ' -f1)"
  [[ "$parser_sha" =~ ^[0-9a-f]{64}$ ]] || { echo "smoke: could not read the parser SHA-256" >&2; exit 1; }
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "parser_sha256=${parser_sha}" >> "$GITHUB_OUTPUT"; fi
  echo "smoke: parser sha256 ${parser_sha}"
fi
# 4. First start on an empty data folder: blank private config written once, not ready (78).
sudo chown 568:568 "$data"
set +e
timeout 120 docker run --rm --name "${run_id}-start" "${limits[@]}" -v "${data}:/data" "$ref"
code=$?
set -e
test "$code" = "78" || { echo "smoke: first start exited ${code}, expected 78 (not ready, blank config written)" >&2; exit 1; }
config="${data}/flight-logs/config/logs.env"
sudo test -f "$config"
test "$(sudo stat -c '%a' "$config")" = "600"
# 5. With synthetic machine settings and a BLANK DJI key the host starts and the decoder waits for the key: no claim,
#    no decode attempt. (Network is off; these values reach nothing.)
sudo tee "$config" >/dev/null <<'CONFIG'
LOGS_INGRESS_HOST=logs-smoke.invalid
ACCESS_ISSUER=https://ledgetoptechnologies.cloudflareaccess.com
ACCESS_AUDIENCE=0000000000000000000000000000000000000000000000000000000000000000
ACCESS_STAFF_PROXY_CLIENT_ID=smoke-staff-proxy.access
ACCESS_DEVICE_PROXY_CLIENT_ID=smoke-device-proxy.access
OPS_DIRECTORY_BASE_URL=https://ops-smoke.invalid/
OPS_DIRECTORY_CLIENT_ID=smoke-directory.access
OPS_DIRECTORY_CLIENT_SECRET=smoke-not-a-secret-000000000000
DJI_API_KEY=
KEYCHAIN_ENCRYPTION_KEY=
CONFIG
sudo chown 568:568 "$config"; sudo chmod 600 "$config"
timeout 30 docker run -d --name "${run_id}-run" "${limits[@]}" --tmpfs /work:size=64m,mode=0700,uid=568,gid=568 -v "${data}:/data" "$ref" >/dev/null
state=""
for _ in $(seq 1 30); do
  state="$(timeout 10 docker exec "${run_id}-run" node -e "fetch('http://127.0.0.1:8081/healthz').then(r => r.json()).then(j => console.log(j.decoder), () => console.log(''))" 2>/dev/null || true)"
  [[ -n "$state" ]] && break
  sleep 1
done
test "$state" = "waiting_for_key" || { echo "smoke: decoder state '${state}', expected waiting_for_key with a blank key" >&2; exit 1; }
echo "smoke: ok ${target} ${ref}"
