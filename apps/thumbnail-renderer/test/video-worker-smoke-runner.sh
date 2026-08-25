#!/usr/bin/env bash
set -Eeuo pipefail
: "${SMOKE_DURATION:=8}"
: "${SMOKE_EXPECTED_SEEK:=5s}"
: "${SMOKE_KIND:=video}"
: "${SMOKE_IMAGE_FORMAT:=jpg}"
: "${SMOKE_FASTSTART:=1}"
: "${SMOKE_PAD_BEFORE_MOOV_BYTES:=0}"

case "$SMOKE_KIND" in
  image)
    case "$SMOKE_IMAGE_FORMAT" in
      jpg) vips black /scratch/source.jpg 640 360 ;;
      png) vips black /scratch/source.png 640 360 ;;
      *) exit 2 ;;
    esac
    ;;
  pdf)
    python3 -c '
import sys
objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
  "<< /Length 27 >>\nstream\n0.9 g 0 0 612 792 re f\nendstream",
]
body = "%PDF-1.4\n"
offsets = [0]
for index, item in enumerate(objects):
  offsets.append(len(body.encode()))
  body += f"{index + 1} 0 obj\n{item}\nendobj\n"
xref = len(body.encode())
body += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
body += "".join(f"{offset:010d} 00000 n \n" for offset in offsets[1:])
body += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
open(sys.argv[1], "wb").write(body.encode())
' /scratch/source.pdf
    ;;
  video)
    video_flags=()
    [[ "$SMOKE_FASTSTART" == "1" ]] && video_flags=(-movflags +faststart)
    ffmpeg -hide_banner -loglevel error -f lavfi \
      -i "testsrc2=duration=${SMOKE_DURATION}:size=640x360:rate=30" \
      -c:v libx264 -pix_fmt yuv420p "${video_flags[@]}" /scratch/source.mp4
    if (( SMOKE_PAD_BEFORE_MOOV_BYTES > 0 )); then
      python3 - "$SMOKE_PAD_BEFORE_MOOV_BYTES" /scratch/source.mp4 <<'PY'
import os
import pathlib
import sys

padding_size = int(sys.argv[1])
source = pathlib.Path(sys.argv[2])
data = source.read_bytes()
offset = 0
moov_offset = None
while offset + 8 <= len(data):
    size = int.from_bytes(data[offset:offset + 4], "big")
    kind = data[offset + 4:offset + 8]
    if size < 8 or offset + size > len(data):
        raise SystemExit("invalid synthetic MP4 atom layout")
    if kind == b"moov":
        moov_offset = offset
        break
    offset += size
if moov_offset is None or moov_offset <= 0 or padding_size < 8 or padding_size >= 2**32:
    raise SystemExit("synthetic non-faststart MP4 did not expose a bounded tail moov atom")
temporary = source.with_suffix(".padded.mp4")
with temporary.open("wb") as handle:
    handle.write(data[:moov_offset])
    handle.write(padding_size.to_bytes(4, "big"))
    handle.write(b"free")
    handle.seek(padding_size - 9, os.SEEK_CUR)
    handle.write(b"\0")
    handle.write(data[moov_offset:])
temporary.replace(source)
PY
    fi
    ;;
  *) exit 2 ;;
esac
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
if [[ "$SMOKE_KIND" == "video" ]]; then
  grep -F "rendering one frame at ${SMOKE_EXPECTED_SEEK} via bounded HTTP range reads" /scratch/worker.log
else
  grep -F "$SMOKE_KIND thumbnail completed" /scratch/worker.log
fi
test "$(stat -c %s /scratch/received.webp)" -le 131072
test "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 /scratch/received.webp)" = "webp,320,240"
