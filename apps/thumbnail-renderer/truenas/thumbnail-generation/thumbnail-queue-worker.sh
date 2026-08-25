#!/usr/bin/env bash
# LTDS TrueNAS unified thumbnail queue worker.
#
# Each process owns one job at a time. The repository-owned supervisor starts a
# bounded number of these isolated slots so images, PDFs, and videos can render
# concurrently without sharing leases or scratch files.
set -Eeuo pipefail

readonly EXPECTED_API_BASE="https://incoming.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1"
readonly ACCESS_API_BASE="https://ops.ledgetopdroneservices.com/api/internal/thumbnail-renderer/v1"
readonly MAX_IMAGE_BYTES=536870912    # exactly 512 MiB
readonly MAX_IMAGE_PIXELS=512000000   # server ceiling; still finite for untrusted input
readonly LARGE_IMAGE_PIXELS=128000000 # serialize large decodes across worker slots
readonly MAX_PDF_BYTES=268435456      # exactly 256 MiB
readonly MAX_VIDEO_BYTES=10737418240  # exactly 10 GiB
readonly MAX_OUTPUT_BYTES=131072      # exactly 128 KiB
readonly MAX_STREAM_BYTES=536870912   # 512 MiB aggregate upstream reads per job
readonly MAX_UPSTREAM_RANGE_BYTES=8388608 # 8 MiB per upstream R2 request
readonly HEARTBEAT_SECONDS=60

: "${LTDSTHUMB_API_BASE:=$EXPECTED_API_BASE}"
: "${LTDSTHUMB_API_TOKEN:=${THUMBNAIL_INGEST_SECRET:-}}"
: "${CF_ACCESS_CLIENT_ID:=}"
: "${CF_ACCESS_CLIENT_SECRET:=}"
: "${LTDSTHUMB_SCRATCH_DIR:=/scratch}"
: "${LTDSTHUMB_IDLE_SECONDS:=30}"
: "${LTDSTHUMB_RENDER_TIMEOUT_SECONDS:=600}"
: "${LTDSTHUMB_WORKER_SLOT:=0}"
: "${LTDSTHUMB_RENDERER_VERSION:=truenas-0.2.0}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "fatal: $*"; exit 2; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

valid_secret() {
  [[ -n "$1" && "$1" != *$'\r'* && "$1" != *$'\n'* ]]
}

[[ "$LTDSTHUMB_API_BASE" == "$EXPECTED_API_BASE" || "$LTDSTHUMB_API_BASE" == "$ACCESS_API_BASE" ]] ||
  die "LTDSTHUMB_API_BASE must be an approved renderer endpoint"
valid_secret "$LTDSTHUMB_API_TOKEN" || die "LTDSTHUMB_API_TOKEN (or THUMBNAIL_INGEST_SECRET) is required"
if [[ -n "$CF_ACCESS_CLIENT_ID" || -n "$CF_ACCESS_CLIENT_SECRET" ]]; then
  valid_secret "$CF_ACCESS_CLIENT_ID" || die "CF_ACCESS_CLIENT_ID must be set with CF_ACCESS_CLIENT_SECRET"
  valid_secret "$CF_ACCESS_CLIENT_SECRET" || die "CF_ACCESS_CLIENT_SECRET must be set with CF_ACCESS_CLIENT_ID"
fi
if [[ "$LTDSTHUMB_API_BASE" == "$ACCESS_API_BASE" && -z "$CF_ACCESS_CLIENT_ID" ]]; then
  die "the Operations renderer endpoint requires CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET"
fi
[[ "$LTDSTHUMB_IDLE_SECONDS" =~ ^[0-9]+$ ]] && (( LTDSTHUMB_IDLE_SECONDS >= 1 && LTDSTHUMB_IDLE_SECONDS <= 3600 )) ||
  die "LTDSTHUMB_IDLE_SECONDS must be an integer from 1 through 3600"
[[ "$LTDSTHUMB_RENDER_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] &&
  (( LTDSTHUMB_RENDER_TIMEOUT_SECONDS >= 30 && LTDSTHUMB_RENDER_TIMEOUT_SECONDS <= 840 )) ||
  die "LTDSTHUMB_RENDER_TIMEOUT_SECONDS must be an integer from 30 through 840"
[[ "$LTDSTHUMB_WORKER_SLOT" =~ ^[0-9]+$ ]] && (( LTDSTHUMB_WORKER_SLOT <= 8 )) ||
  die "LTDSTHUMB_WORKER_SLOT must be an integer from 0 through 8"
[[ "$LTDSTHUMB_RENDERER_VERSION" =~ ^[A-Za-z0-9._-]{1,80}$ ]] ||
  die "LTDSTHUMB_RENDERER_VERSION is invalid"

for dependency in curl python3 ffmpeg ffprobe node vips vipsheader webpmux pdftocairo timeout flock mktemp stat; do
  require_command "$dependency"
done

mkdir -p -- "$LTDSTHUMB_SCRATCH_DIR"
chmod 700 -- "$LTDSTHUMB_SCRATCH_DIR" 2>/dev/null || true
[[ "$(stat -f -c '%T' -- "$LTDSTHUMB_SCRATCH_DIR" 2>/dev/null || true)" == "tmpfs" ]] ||
  die "LTDSTHUMB_SCRATCH_DIR must be a tmpfs RAM mount"
exec 9>"$LTDSTHUMB_SCRATCH_DIR/.thumbnail-queue-worker-${LTDSTHUMB_WORKER_SLOT}.lock"
flock -n 9 || die "another thumbnail queue worker already holds slot $LTDSTHUMB_WORKER_SLOT"

STOP_REQUESTED=0
CURRENT_JOB_DIR=""
STALE_MARKER=""
HEARTBEAT_PID=""
HEARTBEAT_SLEEP_PID_FILE=""
ACTIVE_PID=""
STREAM_PROXY_PID=""
STREAM_PROXY_URL=""
LARGE_IMAGE_LOCKED=0
LAST_HTTP_STATUS=""
LAST_HTTP_BODY=""

stop_heartbeat() {
  if [[ -n "$HEARTBEAT_PID" ]]; then
    if [[ -n "$HEARTBEAT_SLEEP_PID_FILE" && -s "$HEARTBEAT_SLEEP_PID_FILE" ]]; then
      local sleep_pid=""
      sleep_pid=$(<"$HEARTBEAT_SLEEP_PID_FILE")
      [[ "$sleep_pid" =~ ^[0-9]+$ ]] && kill -TERM "$sleep_pid" 2>/dev/null || true
    fi
    kill -TERM "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
  [[ -n "$HEARTBEAT_SLEEP_PID_FILE" ]] && rm -f -- "$HEARTBEAT_SLEEP_PID_FILE"
  return 0
}

stop_active_command() {
  if [[ -n "$ACTIVE_PID" ]]; then
    kill -TERM "$ACTIVE_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$ACTIVE_PID" 2>/dev/null || true
    wait "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=""
  fi
}

stop_stream_proxy() {
  if [[ -n "$STREAM_PROXY_PID" ]]; then
    kill -TERM "$STREAM_PROXY_PID" 2>/dev/null || true
    wait "$STREAM_PROXY_PID" 2>/dev/null || true
    STREAM_PROXY_PID=""
    STREAM_PROXY_URL=""
  fi
}

cleanup_job() {
  stop_active_command
  stop_stream_proxy
  stop_heartbeat
  if (( LARGE_IMAGE_LOCKED != 0 )); then
    flock -u 8 2>/dev/null || true
    exec 8>&-
    LARGE_IMAGE_LOCKED=0
  fi
  if [[ -n "$CURRENT_JOB_DIR" && -d "$CURRENT_JOB_DIR" ]]; then
    rm -rf -- "$CURRENT_JOB_DIR"
  fi
  CURRENT_JOB_DIR=""
  STALE_MARKER=""
  HEARTBEAT_SLEEP_PID_FILE=""
}

request_stop() {
  STOP_REQUESTED=1
  log "shutdown requested"
  stop_active_command
  stop_stream_proxy
  stop_heartbeat
}

trap request_stop INT TERM
trap cleanup_job EXIT

json_string() {
  local document="$1" field="$2"
  JSON_DOCUMENT="$document" JSON_FIELD="$field" python3 -c '
import json, os, sys
try:
    value = json.loads(os.environ["JSON_DOCUMENT"]).get(os.environ["JSON_FIELD"])
except Exception:
    sys.exit(1)
if not isinstance(value, str):
    sys.exit(1)
sys.stdout.write(value)
'
}

json_integer() {
  local document="$1" field="$2"
  JSON_DOCUMENT="$document" JSON_FIELD="$field" python3 -c '
import json, os, sys
try:
    value = json.loads(os.environ["JSON_DOCUMENT"]).get(os.environ["JSON_FIELD"])
except Exception:
    sys.exit(1)
if isinstance(value, bool) or not isinstance(value, int) or value < 0:
    sys.exit(1)
sys.stdout.write(str(value))
'
}

json_heartbeat_payload() {
  python3 -c 'import json,sys; print(json.dumps({"sourceKey":sys.argv[1],"leaseId":sys.argv[2]},separators=(",",":")))' "$1" "$2"
}

json_fail_payload() {
  python3 -c 'import json,sys; print(json.dumps({"sourceKey":sys.argv[1],"leaseId":sys.argv[2],"errorCode":sys.argv[3],"errorMessage":sys.argv[4][:240]},separators=(",",":")))' "$1" "$2" "$3" "$4"
}

json_complete_payload() {
  python3 -c 'import json,sys; print(json.dumps({"leaseId":sys.argv[1],"thumbnailKey":sys.argv[2],"thumbnailEtag":sys.argv[3],"thumbnailSize":int(sys.argv[4])},separators=(",",":")))' "$1" "$2" "$3" "$4"
}

resolve_ops_url() {
  python3 -c '
import sys
from urllib.parse import urljoin, urlsplit
base = urlsplit(sys.argv[1])
value = urljoin(sys.argv[1] + "/", sys.argv[2])
parsed = urlsplit(value)
if (parsed.scheme != "https" or parsed.hostname != base.hostname or parsed.port is not None or
        parsed.username or parsed.password or parsed.fragment):
    raise SystemExit(1)
if not parsed.path.startswith("/api/internal/thumbnail-renderer/v1/thumbnail/"):
    raise SystemExit(1)
print(value)
' "$LTDSTHUMB_API_BASE" "$1"
}

resolve_ops_source_url() {
  python3 -c '
import sys
from urllib.parse import urljoin, urlsplit
base = urlsplit(sys.argv[1])
value = urljoin(sys.argv[1] + "/", sys.argv[2])
parsed = urlsplit(value)
if (parsed.scheme != "https" or parsed.hostname != base.hostname or parsed.port is not None or
        parsed.username or parsed.password or parsed.fragment):
    raise SystemExit(1)
if not parsed.path.startswith("/api/internal/thumbnail-renderer/v1/source/"):
    raise SystemExit(1)
print(value)
' "$LTDSTHUMB_API_BASE" "$1"
}

validate_presigned_url() {
  python3 -c '
import re, sys
from urllib.parse import urlsplit
parsed = urlsplit(sys.argv[1])
host = parsed.hostname or ""
if parsed.scheme != "https" or parsed.username or parsed.password or not re.fullmatch(r"[a-f0-9]{32}\.r2\.cloudflarestorage\.com", host, re.I):
    raise SystemExit(1)
' "$1"
}

_raw_ops_json() {
  local method="$1" url="$2" payload="$3" body_file="$4" status_file="$5"
  local status rc=0
  local args=(
    --silent --show-error --max-redirs 0 --connect-timeout 10 --max-time 30
    --request "$method"
    --header "Authorization: Bearer $LTDSTHUMB_API_TOKEN"
    --header "Accept: application/json"
    --output "$body_file" --write-out '%{http_code}'
  )
  if [[ -n "$CF_ACCESS_CLIENT_ID" ]]; then
    args+=(--header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID")
    args+=(--header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  fi
  if [[ -n "$payload" ]]; then
    args+=(--header "Content-Type: application/json" --data-binary "$payload")
  else
    args+=(--header "Content-Length: 0")
  fi
  status=$(curl "${args[@]}" "$url") || rc=$?
  printf '%s' "$status" >"$status_file"
  return "$rc"
}

_raw_ops_upload() {
  local url="$1" input_file="$2" input_size="$3" body_file="$4" status_file="$5"
  local status rc=0
  local args=(
    --silent --show-error --max-redirs 0 --connect-timeout 10 --max-time 120
    --request PUT
    --header "Authorization: Bearer $LTDSTHUMB_API_TOKEN"
    --header "Accept: application/json"
    --header "Content-Type: image/webp"
    --header "Content-Length: $input_size"
    --upload-file "$input_file"
    --output "$body_file" --write-out '%{http_code}'
  )
  if [[ -n "$CF_ACCESS_CLIENT_ID" ]]; then
    args+=(--header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID")
    args+=(--header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  fi
  status=$(curl "${args[@]}" "$url") || rc=$?
  printf '%s' "$status" >"$status_file"
  return "$rc"
}

_raw_ops_download() {
  local url="$1" output_file="$2" maximum_bytes="$3" status_file="$4"
  local status rc=0
  local args=(
    --silent --show-error --max-redirs 0 --connect-timeout 10 --max-time 840
    --request GET
    --header "Authorization: Bearer $LTDSTHUMB_API_TOKEN"
    --header "Accept: application/octet-stream"
    --header "Accept-Encoding: identity"
    --max-filesize "$maximum_bytes"
    --output "$output_file" --write-out '%{http_code}'
  )
  if [[ -n "$CF_ACCESS_CLIENT_ID" ]]; then
    args+=(--header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID")
    args+=(--header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
  fi
  status=$(curl "${args[@]}" "$url") || rc=$?
  printf '%s' "$status" >"$status_file"
  return "$rc"
}

lease_is_live() {
  [[ -n "$HEARTBEAT_PID" && -n "$STALE_MARKER" && ! -e "$STALE_MARKER" ]] &&
    kill -0 "$HEARTBEAT_PID" 2>/dev/null
}

mark_stale() {
  [[ -n "$STALE_MARKER" ]] && : >"$STALE_MARKER"
}

run_guarded() {
  lease_is_live || return 75
  "$@" &
  ACTIVE_PID=$!
  while kill -0 "$ACTIVE_PID" 2>/dev/null; do
    if ! lease_is_live || (( STOP_REQUESTED != 0 )); then
      stop_active_command
      return 75
    fi
    sleep 1
  done
  local rc=0
  wait "$ACTIVE_PID" || rc=$?
  ACTIVE_PID=""
  lease_is_live || return 75
  return "$rc"
}

ops_json_call() {
  local method="$1" url="$2" payload="${3:-}"
  local body_file status_file
  body_file=$(mktemp "$CURRENT_JOB_DIR/http-body.XXXXXX")
  status_file=$(mktemp "$CURRENT_JOB_DIR/http-status.XXXXXX")
  local rc=0
  run_guarded _raw_ops_json "$method" "$url" "$payload" "$body_file" "$status_file" || rc=$?
  (( rc == 0 )) || return "$rc"
  LAST_HTTP_STATUS=$(<"$status_file")
  LAST_HTTP_BODY=$(<"$body_file")
  rm -f -- "$body_file" "$status_file"
}

ops_upload_call() {
  local url="$1" input_file="$2" input_size="$3"
  local body_file status_file
  body_file=$(mktemp "$CURRENT_JOB_DIR/upload-body.XXXXXX")
  status_file=$(mktemp "$CURRENT_JOB_DIR/upload-status.XXXXXX")
  local rc=0
  run_guarded _raw_ops_upload "$url" "$input_file" "$input_size" "$body_file" "$status_file" || rc=$?
  (( rc == 0 )) || return "$rc"
  LAST_HTTP_STATUS=$(<"$status_file")
  LAST_HTTP_BODY=$(<"$body_file")
  rm -f -- "$body_file" "$status_file"
}

download_source() {
  local url="$1" output_file="$2" expected_size="$3" maximum_bytes="$4"
  local status_file rc=0 actual_size
  status_file=$(mktemp "$CURRENT_JOB_DIR/download-status.XXXXXX")
  run_guarded _raw_ops_download "$url" "$output_file" "$maximum_bytes" "$status_file" || rc=$?
  (( rc == 0 )) || return "$rc"
  LAST_HTTP_STATUS=$(<"$status_file")
  rm -f -- "$status_file"
  [[ "$LAST_HTTP_STATUS" == "200" ]] || return 1
  actual_size=$(stat -c '%s' -- "$output_file" 2>/dev/null || printf '0')
  [[ "$actual_size" == "$expected_size" ]] || return 1
}

heartbeat_once() {
  local source_key="$1" lease_id="$2" payload body_file status_file status body
  payload=$(json_heartbeat_payload "$source_key" "$lease_id") || return 1
  body_file=$(mktemp "$CURRENT_JOB_DIR/heartbeat-body.XXXXXX")
  status_file=$(mktemp "$CURRENT_JOB_DIR/heartbeat-status.XXXXXX")
  _raw_ops_json POST "$LTDSTHUMB_API_BASE/heartbeat" "$payload" "$body_file" "$status_file" || return 1
  status=$(<"$status_file")
  body=$(<"$body_file")
  rm -f -- "$body_file" "$status_file"
  [[ "$status" == "200" ]] || return 1
  [[ "$(json_string "$body" status 2>/dev/null || true)" == "ok" ]]
}

start_heartbeat() {
  local source_key="$1" lease_id="$2"
  # Confirm the immediate heartbeat before beginning any source work.
  if ! heartbeat_once "$source_key" "$lease_id"; then
    mark_stale
    log "claim abandoned: immediate heartbeat was not accepted"
    return 1
  fi
  (
    while true; do
      sleep "$HEARTBEAT_SECONDS" &
      local sleep_pid=$!
      printf '%s' "$sleep_pid" >"$HEARTBEAT_SLEEP_PID_FILE"
      wait "$sleep_pid" || exit 0
      rm -f -- "$HEARTBEAT_SLEEP_PID_FILE"
      if ! heartbeat_once "$source_key" "$lease_id"; then
        mark_stale
        log "claim abandoned: heartbeat was not accepted"
        exit 1
      fi
    done
  ) &
  HEARTBEAT_PID=$!
}

fail_job() {
  local source_key="$1" lease_id="$2" code="$3" message="$4" payload result
  log "thumbnail failed ($code)"
  payload=$(json_fail_payload "$source_key" "$lease_id" "$code" "$message") || return 1
  if ! ops_json_call POST "$LTDSTHUMB_API_BASE/fail" "$payload"; then
    mark_stale
    return 1
  fi
  result=$(json_string "$LAST_HTTP_BODY" status 2>/dev/null || true)
  if [[ "$LAST_HTTP_STATUS" == "200" && ( "$result" == "retrying" || "$result" == "failed" ) ]]; then
    stop_heartbeat
    return 0
  fi
  mark_stale
  return 1
}

valid_webp() {
  local input_file="$1" details
  details=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 "$input_file" 2>/dev/null) || return 1
  [[ "$details" == "webp,320,240" || "$details" == "320,240,webp" ]] || return 1
  python3 -c '
import pathlib, sys
data = pathlib.Path(sys.argv[1]).read_bytes()
if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
    raise SystemExit(1)
' "$input_file"
}

image_pixel_class() {
  local input_file="$1" width height
  width=$(vipsheader -f width "$input_file" 2>/dev/null) || return 1
  height=$(vipsheader -f height "$input_file" 2>/dev/null) || return 1
  python3 -c '
import sys
try:
    width, height, large, maximum = map(int, sys.argv[1:])
except ValueError:
    raise SystemExit(1)
if width <= 0 or height <= 0:
    raise SystemExit(1)
pixels = width * height
print("too_large" if pixels > maximum else "large" if pixels > large else "normal")
' "$width" "$height" "$LARGE_IMAGE_PIXELS" "$MAX_IMAGE_PIXELS"
}

acquire_large_image_slot() {
  exec 8>"$LTDSTHUMB_SCRATCH_DIR/.thumbnail-large-image.lock"
  while ! flock -n 8; do
    lease_is_live || { exec 8>&-; return 1; }
    (( STOP_REQUESTED == 0 )) || { exec 8>&-; return 1; }
    sleep 1
  done
  LARGE_IMAGE_LOCKED=1
}

release_large_image_slot() {
  (( LARGE_IMAGE_LOCKED != 0 )) || return 0
  flock -u 8 2>/dev/null || true
  exec 8>&-
  LARGE_IMAGE_LOCKED=0
}

start_stream_proxy() {
  local source_url="$1" auth_mode="$2" port_file="$CURRENT_JOB_DIR/stream-proxy-port"
  local source_url_file="$CURRENT_JOB_DIR/stream-source-url"
  rm -f -- "$port_file" "$source_url_file"
  (umask 077; printf '%s' "$source_url" >"$source_url_file")
  python3 -c '
import http.server, os, re, sys, threading, urllib.error, urllib.request

port_file = sys.argv[1]
source_url_file = sys.argv[2]
max_stream_bytes = int(sys.argv[3])
max_upstream_range_bytes = int(sys.argv[4])
auth_mode = sys.argv[5]
with open(source_url_file, "r", encoding="utf-8") as handle:
    remote_url = handle.read()
os.unlink(source_url_file)
budget_lock = threading.Lock()
bytes_forwarded = 0

base_headers = {"Accept-Encoding": "identity"}
if auth_mode == "ops":
    token = os.environ.get("LTDSTHUMB_API_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("missing renderer API token")
    base_headers["Authorization"] = f"Bearer {token}"
    access_id = os.environ.get("CF_ACCESS_CLIENT_ID", "")
    access_secret = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
    if access_id and access_secret:
        base_headers["CF-Access-Client-Id"] = access_id
        base_headers["CF-Access-Client-Secret"] = access_secret
elif auth_mode != "presigned":
    raise SystemExit("invalid stream authentication mode")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect)

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        pass

    def do_HEAD(self):
        self.forward(False)

    def do_GET(self):
        self.forward(True)

    def forward(self, include_body):
        global bytes_forwarded
        if self.path != "/source":
            self.send_error(404)
            return
        headers = dict(base_headers)
        range_value = self.headers.get("Range")
        if range_value:
            range_match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_value)
            if not range_match:
                self.send_error(416)
                return
            requested_start = int(range_match.group(1))
            requested_end = int(range_match.group(2)) if range_match.group(2) else None
            if requested_end is not None and requested_end < requested_start:
                self.send_error(416)
                return
        elif not include_body:
            # The R2 URL is signed for GET, so satisfy a local HEAD with a
            # one-byte GET and synthesize the full length from Content-Range.
            headers["Range"] = "bytes=0-0"
        else:
            # The renderer must never turn a missing client Range into a full
            # object transfer. FFmpeg/FFprobe are configured for seekable HTTP
            # and can retry with an explicit byte range.
            self.send_error(416)
            return

        upstream_start = requested_start if include_body else 0
        upstream_end = min(
            requested_end if requested_end is not None else upstream_start + max_upstream_range_bytes - 1,
            upstream_start + max_upstream_range_bytes - 1,
        ) if include_body else 0
        headers["Range"] = f"bytes={upstream_start}-{upstream_end}"
        request = urllib.request.Request(remote_url, headers=headers, method="GET")
        try:
            response = opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            self.send_response(error.code)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        except Exception:
            self.send_error(502)
            return
        with response:
            content_range = response.headers.get("Content-Range", "")
            content_match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if not content_match:
                self.send_error(502)
                return
            total_size = int(content_match.group(3))
            if not include_body:
                self.send_response(200)
                for name in ("Content-Type", "Accept-Ranges", "ETag"):
                    value = response.headers.get(name)
                    if value is not None:
                        self.send_header(name, value)
                self.send_header("Content-Length", str(total_size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return

            final_end = min(requested_end if requested_end is not None else total_size - 1, total_size - 1)
            if requested_start >= total_size or final_end < requested_start:
                self.send_error(416)
                return
            self.send_response(206)
            self.send_header("Content-Type", response.headers.get("Content-Type", "application/octet-stream"))
            self.send_header("Content-Length", str(final_end - requested_start + 1))
            self.send_header("Content-Range", f"bytes {requested_start}-{final_end}/{total_size}")
            self.send_header("Accept-Ranges", "bytes")
            etag = response.headers.get("ETag")
            if etag is not None:
                self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

            current_start = requested_start
            current_response = response
            try:
                while current_start <= final_end:
                    current_end = min(current_start + max_upstream_range_bytes - 1, final_end)
                    if current_start != requested_start:
                        next_headers = dict(base_headers)
                        next_headers["Range"] = f"bytes={current_start}-{current_end}"
                        next_request = urllib.request.Request(remote_url, headers=next_headers, method="GET")
                        current_response = opener.open(next_request, timeout=30)
                    try:
                        while True:
                            chunk = current_response.read(262144)
                            if not chunk:
                                break
                            with budget_lock:
                                if bytes_forwarded + len(chunk) > max_stream_bytes:
                                    self.close_connection = True
                                    return
                                bytes_forwarded += len(chunk)
                            self.wfile.write(chunk)
                    finally:
                        if current_response is not response:
                            current_response.close()
                    current_start = current_end + 1
            except (BrokenPipeError, ConnectionResetError):
                pass

class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

server = Server(("127.0.0.1", 0), Handler)
with open(port_file, "x", encoding="ascii") as handle:
    handle.write(str(server.server_port))
os.chmod(port_file, 0o600)
server.serve_forever(poll_interval=0.2)
' "$port_file" "$source_url_file" "$MAX_STREAM_BYTES" "$MAX_UPSTREAM_RANGE_BYTES" "$auth_mode" &
  STREAM_PROXY_PID=$!

  local wait_count=0 port=""
  while [[ ! -s "$port_file" ]]; do
    kill -0 "$STREAM_PROXY_PID" 2>/dev/null || return 1
    sleep 0.1
    wait_count=$((wait_count + 1))
    (( wait_count < 100 )) || return 1
  done
  port=$(<"$port_file")
  [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || return 1
  STREAM_PROXY_URL="http://127.0.0.1:${port}/source"
}

probe_video_seek() {
  local stream_url="$1" demuxer="$2" timeout_seconds="$3"
  local duration_file="$CURRENT_JOB_DIR/video-duration" rc=0 duration
  local -a input_options=(-f "$demuxer")
  [[ "$demuxer" == "mov" ]] && input_options+=(-enable_drefs 0 -use_absolute_path 0)
  rm -f -- "$duration_file"
  run_guarded timeout --signal=TERM --kill-after=10s "$timeout_seconds" \
    ffprobe -v error -protocol_whitelist http,tcp \
    -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \
    "${input_options[@]}" "$stream_url" >"$duration_file" || rc=$?
  (( rc == 0 )) || return "$rc"
  duration=$(<"$duration_file")
  VIDEO_SEEK=$(python3 -c '
import math, sys
try:
    duration = float(sys.argv[1])
except ValueError:
    raise SystemExit(1)
if not math.isfinite(duration) or duration <= 0:
    raise SystemExit(1)
print("5" if duration >= 5 else format(duration / 2, ".6f"))
' "$duration")
}

render_video() {
  local stream_url="$1" output_file="$2" demuxer="$3"
  local quality output_size rc=0 remaining probe_timeout
  local render_deadline=$(( $(date +%s) + LTDSTHUMB_RENDER_TIMEOUT_SECONDS ))
  local -a input_options=(-f "$demuxer")
  [[ "$demuxer" == "mov" ]] && input_options+=(-enable_drefs 0 -use_absolute_path 0)
  VIDEO_SEEK=""
  remaining=$(( render_deadline - $(date +%s) ))
  (( remaining > 0 )) || return 124
  probe_timeout=$remaining
  (( probe_timeout > 60 )) && probe_timeout=60
  probe_video_seek "$stream_url" "$demuxer" "$probe_timeout" || rc=$?
  (( rc == 0 )) || return "$rc"
  log "rendering one frame at ${VIDEO_SEEK}s via bounded HTTP range reads"
  for quality in 75 60 45 30; do
    remaining=$(( render_deadline - $(date +%s) ))
    (( remaining > 0 )) || return 124
    rm -f -- "$output_file"
    rc=0
    run_guarded timeout --signal=TERM --kill-after=10s "$remaining" \
      ffmpeg -hide_banner -loglevel quiet -nostdin -y \
      -ss "$VIDEO_SEEK" -protocol_whitelist http,tcp "${input_options[@]}" -i "$stream_url" \
      -map 0:v:0 -frames:v 1 -an -sn -dn -map_metadata -1 -map_chapters -1 \
      -vf "scale=320:240:force_original_aspect_ratio=increase,crop=320:240,setsar=1" \
      -c:v libwebp -compression_level 6 -q:v "$quality" "$output_file" || rc=$?
    if (( rc != 0 )); then
      (( rc == 75 )) && return 75
      continue
    fi
    output_size=$(stat -c '%s' -- "$output_file" 2>/dev/null || printf '0')
    if (( output_size > 0 && output_size <= MAX_OUTPUT_BYTES )) && valid_webp "$output_file"; then
      return 0
    fi
  done
  return 1
}

claim_once() {
  local body_file status_file
  body_file=$(mktemp "$CURRENT_JOB_DIR/claim-body.XXXXXX")
  status_file=$(mktemp "$CURRENT_JOB_DIR/claim-status.XXXXXX")
  if ! _raw_ops_json POST "$LTDSTHUMB_API_BASE/claim?includeKind=all" "" "$body_file" "$status_file"; then
    log "claim request failed"
    return 20
  fi
  LAST_HTTP_STATUS=$(<"$status_file")
  LAST_HTTP_BODY=$(<"$body_file")
  rm -f -- "$body_file" "$status_file"
  [[ "$LAST_HTTP_STATUS" == "200" ]] || {
    log "claim rejected with HTTP $LAST_HTTP_STATUS"
    return 20
  }
  local result
  result=$(json_string "$LAST_HTTP_BODY" status 2>/dev/null || true)
  [[ "$result" == "idle" ]] && return 10
  [[ "$result" == "claimed" ]] || {
    log "claim response was invalid"
    return 20
  }
  return 0
}

process_one() {
  cleanup_job
  CURRENT_JOB_DIR=$(mktemp -d "$LTDSTHUMB_SCRATCH_DIR/thumbnail-job.XXXXXX")
  chmod 700 -- "$CURRENT_JOB_DIR"
  STALE_MARKER="$CURRENT_JOB_DIR/lease-stale"
  HEARTBEAT_SLEEP_PID_FILE="$CURRENT_JOB_DIR/heartbeat-sleep-pid"

  local claim_rc=0
  claim_once || claim_rc=$?
  if (( claim_rc != 0 )); then
    cleanup_job
    return "$claim_rc"
  fi

  local lease_id source_key source_size media_kind source_content_type thumbnail_key source_url presigned_url upload_url
  lease_id=$(json_string "$LAST_HTTP_BODY" leaseId 2>/dev/null || true)
  source_key=$(json_string "$LAST_HTTP_BODY" sourceKey 2>/dev/null || true)
  source_size=$(json_integer "$LAST_HTTP_BODY" sourceSize 2>/dev/null || true)
  media_kind=$(json_string "$LAST_HTTP_BODY" mediaKind 2>/dev/null || true)
  source_content_type=$(json_string "$LAST_HTTP_BODY" sourceContentType 2>/dev/null || true)
  thumbnail_key=$(json_string "$LAST_HTTP_BODY" thumbnailKey 2>/dev/null || true)
  source_url=$(json_string "$LAST_HTTP_BODY" r2SourceUrl 2>/dev/null || true)
  presigned_url=$(json_string "$LAST_HTTP_BODY" r2PresignedUrl 2>/dev/null || true)
  upload_url=$(json_string "$LAST_HTTP_BODY" r2UploadUrl 2>/dev/null || true)

  if [[ -z "$lease_id" || -z "$source_key" || -z "$source_size" || -z "$thumbnail_key" || -z "$upload_url" ]]; then
    log "claim response omitted required fields; attempt abandoned"
    cleanup_job
    return 20
  fi

  if ! start_heartbeat "$source_key" "$lease_id"; then
    cleanup_job
    return 20
  fi

  log "${media_kind:-unknown} claim accepted ($source_size bytes)"
  local maximum_source_bytes=0
  case "$media_kind" in
    image) maximum_source_bytes=$MAX_IMAGE_BYTES ;;
    pdf) maximum_source_bytes=$MAX_PDF_BYTES ;;
    video) maximum_source_bytes=$MAX_VIDEO_BYTES ;;
    *)
      fail_job "$source_key" "$lease_id" unexpected_media_kind "Unified worker received an unsupported media kind" || true
      cleanup_job
      return 20
      ;;
  esac
  if (( source_size <= 0 || source_size > maximum_source_bytes )); then
    fail_job "$source_key" "$lease_id" input_too_large "Source exceeds the exact renderer input limit" || true
    cleanup_job
    return 20
  fi
  upload_url=$(resolve_ops_url "$upload_url" 2>/dev/null || true)
  if [[ -z "$upload_url" ]]; then
    fail_job "$source_key" "$lease_id" invalid_upload_url "Claim provided an invalid upload URL" || true
    cleanup_job
    return 20
  fi

  local thumbnail_file="$CURRENT_JOB_DIR/thumbnail.webp" render_rc=0 thumbnail_size
  if [[ "$media_kind" == "video" ]]; then
    local stream_url stream_auth_mode demuxer=""
    if [[ -n "$presigned_url" ]] && validate_presigned_url "$presigned_url"; then
      stream_url="$presigned_url"
      stream_auth_mode="presigned"
    else
      source_url=$(resolve_ops_source_url "$source_url" 2>/dev/null || true)
      if [[ -z "$source_url" ]]; then
        fail_job "$source_key" "$lease_id" invalid_source_url "Claim did not provide a valid range-streaming source URL" || true
        cleanup_job
        return 20
      fi
      stream_url="$source_url"
      stream_auth_mode="ops"
    fi
    if ! start_stream_proxy "$stream_url" "$stream_auth_mode"; then
      fail_job "$source_key" "$lease_id" stream_proxy_failed "The RAM-only range proxy could not start" || true
      cleanup_job
      return 20
    fi
    # The API derives mediaKind from authoritative object metadata. Select the
    # forced demuxer from that same bounded content type before consulting the
    # key suffix, so a valid MP4 named `disguised.jpg` is never rejected or sent
    # through an image decoder. Octet-stream legacy objects retain an explicit
    # approved-extension fallback.
    source_content_type=${source_content_type%%;*}
    source_content_type=${source_content_type,,}
    source_content_type=${source_content_type//[[:space:]]/}
    case "$source_content_type" in
      video/mp4|video/quicktime|video/3gpp) demuxer="mov" ;;
      video/x-matroska|video/webm) demuxer="matroska" ;;
      video/x-msvideo) demuxer="avi" ;;
      video/mpeg) demuxer="mpeg" ;;
      video/mp2t) demuxer="mpegts" ;;
      video/x-ms-wmv) demuxer="asf" ;;
      video/x-flv) demuxer="flv" ;;
      video/mxf|application/mxf) demuxer="mxf" ;;
      application/octet-stream|"")
        case "${source_key,,}" in
          *.mp4|*.mov) demuxer="mov" ;;
          *.mkv|*.webm) demuxer="matroska" ;;
          *.avi) demuxer="avi" ;;
          *.mts|*.m2ts|*.ts) demuxer="mpegts" ;;
          *.mpg|*.mpeg) demuxer="mpeg" ;;
          *.wmv) demuxer="asf" ;;
          *.flv) demuxer="flv" ;;
          *.mxf) demuxer="mxf" ;;
          *.3gp) demuxer="mov" ;;
        esac
        ;;
    esac
    if [[ -z "$demuxer" ]]; then
      fail_job "$source_key" "$lease_id" unsupported_video_container "Video metadata did not identify an approved container" || true
      cleanup_job
      return 20
    fi
    render_video "$STREAM_PROXY_URL" "$thumbnail_file" "$demuxer" || render_rc=$?
  else
    source_url=$(resolve_ops_source_url "$source_url" 2>/dev/null || true)
    if [[ -z "$source_url" ]]; then
      fail_job "$source_key" "$lease_id" invalid_source_url "Claim provided an invalid source URL" || true
      cleanup_job
      return 20
    fi
    local source_file="$CURRENT_JOB_DIR/source.bin"
    if ! download_source "$source_url" "$source_file" "$source_size" "$maximum_source_bytes"; then
      fail_job "$source_key" "$lease_id" source_transfer_failed "Exact leased source transfer failed" || true
      cleanup_job
      return 20
    fi
    if [[ "$media_kind" == "image" ]]; then
      local pixel_class
      pixel_class=$(image_pixel_class "$source_file" 2>/dev/null || true)
      case "$pixel_class" in
        too_large)
          fail_job "$source_key" "$lease_id" pixel_limit_exceeded "Decoded image exceeds the bounded 512 MP server limit" || true
          cleanup_job
          return 20
          ;;
        large)
          if ! acquire_large_image_slot; then
            log "large image attempt stopped before its serialized render slot became available"
            cleanup_job
            return 20
          fi
          log "large image render entered the serialized server slot"
          ;;
        normal) ;;
        *)
          fail_job "$source_key" "$lease_id" invalid_media "Image dimensions could not be validated" || true
          cleanup_job
          return 20
          ;;
      esac
    fi
    run_guarded timeout --signal=TERM --kill-after=10s "$LTDSTHUMB_RENDER_TIMEOUT_SECONDS" \
      node /app/src/queue-render.mjs "$media_kind" "$source_file" "$thumbnail_file" "$CURRENT_JOB_DIR" \
      "$LTDSTHUMB_RENDER_TIMEOUT_SECONDS" || render_rc=$?
    release_large_image_slot
  fi
  if (( render_rc == 75 )); then
    log "attempt stopped because its lease became stale"
    cleanup_job
    return 20
  fi
  if (( render_rc != 0 )); then
    fail_job "$source_key" "$lease_id" render_failed "Renderer could not create a bounded 320x240 WebP" || true
    cleanup_job
    return 20
  fi

  thumbnail_size=$(stat -c '%s' -- "$thumbnail_file")
  if ! ops_upload_call "$upload_url" "$thumbnail_file" "$thumbnail_size"; then
    log "attempt stopped before upload completion"
    cleanup_job
    return 20
  fi
  local upload_status thumbnail_etag stored_size
  upload_status=$(json_string "$LAST_HTTP_BODY" status 2>/dev/null || true)
  thumbnail_etag=$(json_string "$LAST_HTTP_BODY" etag 2>/dev/null || true)
  stored_size=$(json_integer "$LAST_HTTP_BODY" size 2>/dev/null || true)
  if [[ "$LAST_HTTP_STATUS" != "200" || "$upload_status" != "stored" || -z "$thumbnail_etag" || "$stored_size" != "$thumbnail_size" ]]; then
    fail_job "$source_key" "$lease_id" upload_failed "Operations did not accept the rendered WebP" || true
    cleanup_job
    return 20
  fi

  local complete_payload complete_status
  complete_payload=$(json_complete_payload "$lease_id" "$thumbnail_key" "$thumbnail_etag" "$thumbnail_size")
  if ! ops_json_call POST "$LTDSTHUMB_API_BASE/complete" "$complete_payload"; then
    log "attempt stopped before completion acknowledgement"
    cleanup_job
    return 20
  fi
  complete_status=$(json_string "$LAST_HTTP_BODY" status 2>/dev/null || true)
  if [[ "$LAST_HTTP_STATUS" == "200" && ( "$complete_status" == "ready" || "$complete_status" == "already_ready" ) ]]; then
    stop_heartbeat
    log "$media_kind thumbnail completed"
    cleanup_job
    return 0
  fi

  mark_stale
  log "completion was not accepted; attempt abandoned"
  cleanup_job
  return 20
}

main() {
  local once=0
  case "${1:-}" in
    "") ;;
    --once) once=1 ;;
    *) die "usage: $0 [--once]" ;;
  esac

  log "TrueNAS thumbnail queue worker started (version=$LTDSTHUMB_RENDERER_VERSION slot=$LTDSTHUMB_WORKER_SLOT media=image,pdf,video)"
  while (( STOP_REQUESTED == 0 )); do
    local rc=0
    process_one || rc=$?
    if (( once != 0 )); then
      (( rc == 10 )) && return 0
      return "$rc"
    fi
    (( STOP_REQUESTED != 0 )) && break
    if (( rc == 10 )); then
      sleep "$LTDSTHUMB_IDLE_SECONDS" &
    else
      sleep 5 &
    fi
    ACTIVE_PID=$!
    wait "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=""
  done
  log "TrueNAS thumbnail queue worker stopped (slot=$LTDSTHUMB_WORKER_SLOT)"
}

main "$@"
