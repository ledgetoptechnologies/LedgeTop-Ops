#!/usr/bin/env bash
set -Eeuo pipefail
: "${SMOKE_DURATION:=8}"
: "${SMOKE_EXPECTED_SEEK:=5s}"

apt-get update -qq
apt-get install -y --no-install-recommends curl python3 ca-certificates openssl >/dev/null 2>&1
ffmpeg -hide_banner -loglevel error -f lavfi \
  -i "testsrc2=duration=${SMOKE_DURATION}:size=640x360:rate=30" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart /scratch/source.mp4
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=incoming.ledgetopdroneservices.com \
  -addext subjectAltName=DNS:incoming.ledgetopdroneservices.com,DNS:0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com \
  -keyout /scratch/server.key -out /scratch/server.crt >/dev/null 2>&1

SSL_CERT_FILE=/scratch/server.crt python3 /scripts/mock.py &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
for _ in {1..50}; do
  if curl --silent --cacert /scratch/server.crt https://incoming.ledgetopdroneservices.com/ >/dev/null; then
    break
  fi
  sleep 0.1
done
kill -0 "$server_pid"

export SSL_CERT_FILE=/scratch/server.crt
export CURL_CA_BUNDLE=/scratch/server.crt
export LTDSTHUMB_API_BASE=https://incoming.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1
export LTDSTHUMB_API_TOKEN=synthetic-renderer-token-at-least-32-bytes
export LTDSTHUMB_SCRATCH_DIR=/scratch
export LTDSTHUMB_RENDER_TIMEOUT_SECONDS=120
bash /scripts/thumbnail-queue-worker.sh --once 2>&1 | tee /scratch/worker.log

test -f /scratch/completed
grep -F "rendering one frame at ${SMOKE_EXPECTED_SEEK} via bounded HTTP range reads" /scratch/worker.log
test "$(stat -c %s /scratch/received.webp)" -le 131072
test "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 /scratch/received.webp)" = "webp,320,240"
