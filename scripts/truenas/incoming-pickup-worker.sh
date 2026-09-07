#!/usr/bin/env bash
#
# TrueNAS incoming-quarantine pickup worker.
#
# This worker is deliberately separate from Client Delivery and the thumbnail
# renderer.  It can read and delete only the private Incoming R2 bucket and can
# call only the Incoming acceptance receipt endpoint.  It never opens, renders,
# extracts, or publishes an inbound object before ClamAV has accepted the exact
# downloaded bytes.
#
# Run from cron at the start of each hour with --once.  The non-blocking flock
# keeps an overdue run from overlapping the next one.
set -Eeuo pipefail
umask 077

readonly DEFAULT_API_BASE="https://incoming.ledgetopdroneservices.com/api/internal/uploads"
readonly DEFAULT_MAX_SOURCE_BYTES=68719476736 # 64 GiB; explicit and bounded.
readonly DEFAULT_SCAN_TIMEOUT_SECONDS=900
readonly DEFAULT_MAX_JOBS=24
readonly DEFAULT_OVERSIZE_RETRY_SECONDS=86400
readonly LIST_PAGE_SIZE=1000

: "${INCOMING_PICKUP_R2_BUCKET:?INCOMING_PICKUP_R2_BUCKET is required}"
: "${INCOMING_PICKUP_R2_ENDPOINT:?INCOMING_PICKUP_R2_ENDPOINT is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${INCOMING_PICKUP_SECRET:?INCOMING_PICKUP_SECRET is required}"
: "${INCOMING_PICKUP_DESTINATION_DIR:?INCOMING_PICKUP_DESTINATION_DIR is required}"
: "${INCOMING_PICKUP_API_BASE:=$DEFAULT_API_BASE}"
: "${INCOMING_PICKUP_MAX_SOURCE_BYTES:=$DEFAULT_MAX_SOURCE_BYTES}"
: "${INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS:=$DEFAULT_SCAN_TIMEOUT_SECONDS}"
: "${INCOMING_PICKUP_MAX_JOBS:=$DEFAULT_MAX_JOBS}"
: "${INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS:=$DEFAULT_OVERSIZE_RETRY_SECONDS}"
: "${INCOMING_PICKUP_STAGING_DIR:=$INCOMING_PICKUP_DESTINATION_DIR/.incoming-staging}"
: "${INCOMING_PICKUP_STATE_DIR:=$INCOMING_PICKUP_DESTINATION_DIR/.incoming-state}"
: "${AWS_REGION:=auto}"

log() {
  # Keep logs useful for an operator but never include object keys, filenames,
  # local paths, request IDs, content, credentials, URLs, or checksums.
  printf '[%s] incoming-pickup %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() { log "fatal: $*"; exit 2; }

require_command() { command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"; }

valid_secret() { [[ -n "$1" && "$1" != *$'\r'* && "$1" != *$'\n'* ]]; }

valid_integer() { [[ "$1" =~ ^[0-9]+$ ]]; }

valid_absolute_dir() { [[ "$1" == /* && "$1" != "/" ]]; }

valid_api_base() {
  [[ "$1" =~ ^https://incoming\.(ledgetopdroneservices|ledgetoptechnologies)\.com/api/internal/uploads$ ]]
}

valid_r2_endpoint() {
  [[ "$1" =~ ^https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com$ ]]
}

valid_bucket() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,62}$ ]]; }

valid_upload_id() { [[ "$1" =~ ^[A-Za-z0-9_-]{8,200}$ ]]; }

valid_claim_token() { [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; }

for dependency in aws curl clamscan sha256sum timeout flock python3 stat mktemp mkdir mv rm find dirname awk sleep; do
  require_command "$dependency"
done

valid_bucket "$INCOMING_PICKUP_R2_BUCKET" || die "INCOMING_PICKUP_R2_BUCKET is invalid"
valid_r2_endpoint "$INCOMING_PICKUP_R2_ENDPOINT" || die "INCOMING_PICKUP_R2_ENDPOINT must be an exact Cloudflare R2 endpoint"
valid_api_base "$INCOMING_PICKUP_API_BASE" || die "INCOMING_PICKUP_API_BASE must be an approved Incoming receipt endpoint"
valid_secret "$AWS_ACCESS_KEY_ID" || die "AWS_ACCESS_KEY_ID is invalid"
valid_secret "$AWS_SECRET_ACCESS_KEY" || die "AWS_SECRET_ACCESS_KEY is invalid"
valid_secret "$INCOMING_PICKUP_SECRET" || die "INCOMING_PICKUP_SECRET is invalid"
valid_integer "$INCOMING_PICKUP_MAX_SOURCE_BYTES" && (( INCOMING_PICKUP_MAX_SOURCE_BYTES >= 1 && INCOMING_PICKUP_MAX_SOURCE_BYTES <= 1099511627776 )) ||
  die "INCOMING_PICKUP_MAX_SOURCE_BYTES must be an integer from 1 through 1099511627776"
valid_integer "$INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS" && (( INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS >= 30 && INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS <= 7200 )) ||
  die "INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS must be an integer from 30 through 7200"
valid_integer "$INCOMING_PICKUP_MAX_JOBS" && (( INCOMING_PICKUP_MAX_JOBS >= 1 && INCOMING_PICKUP_MAX_JOBS <= 1000 )) ||
  die "INCOMING_PICKUP_MAX_JOBS must be an integer from 1 through 1000"
valid_integer "$INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS" && (( INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS >= 60 && INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS <= 86400 )) ||
  die "INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS must be an integer from 60 through 86400"
valid_absolute_dir "$INCOMING_PICKUP_DESTINATION_DIR" || die "INCOMING_PICKUP_DESTINATION_DIR must be an absolute non-root path"
valid_absolute_dir "$INCOMING_PICKUP_STAGING_DIR" || die "INCOMING_PICKUP_STAGING_DIR must be an absolute non-root path"
valid_absolute_dir "$INCOMING_PICKUP_STATE_DIR" || die "INCOMING_PICKUP_STATE_DIR must be an absolute non-root path"

mkdir -p -- "$INCOMING_PICKUP_DESTINATION_DIR" "$INCOMING_PICKUP_STAGING_DIR" "$INCOMING_PICKUP_STATE_DIR"
chmod 700 -- "$INCOMING_PICKUP_DESTINATION_DIR" "$INCOMING_PICKUP_STAGING_DIR" "$INCOMING_PICKUP_STATE_DIR" 2>/dev/null || true

destination_device=$(stat -c '%d' -- "$INCOMING_PICKUP_DESTINATION_DIR")
staging_device=$(stat -c '%d' -- "$INCOMING_PICKUP_STAGING_DIR")
[[ "$destination_device" == "$staging_device" ]] || die "destination and staging directories must share one filesystem for atomic promotion"

exec 9>"$INCOMING_PICKUP_STATE_DIR/incoming-pickup.lock"
if ! flock -n 9; then
  log "run skipped because another pickup run is active"
  exit 0
fi

CURRENT_STAGE=""
CURRENT_LIST_FILE=""
PICKUP_ATTEMPTED=0
LIST_NEXT_TOKEN=""
HEARTBEAT_PID=""
HEARTBEAT_STATE_FILE=""
cleanup() {
  if [[ -n "$HEARTBEAT_PID" ]]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  if [[ -n "$CURRENT_STAGE" && -d "$CURRENT_STAGE" ]]; then
    rm -rf -- "$CURRENT_STAGE"
  fi
  if [[ -n "$CURRENT_LIST_FILE" && -f "$CURRENT_LIST_FILE" ]]; then
    rm -f -- "$CURRENT_LIST_FILE"
  fi
}
trap cleanup EXIT

aws_r2() {
  aws --no-cli-pager --region "$AWS_REGION" --endpoint-url "$INCOMING_PICKUP_R2_ENDPOINT" "$@"
}

json_field() {
  JSON_DOCUMENT="$1" JSON_FIELD="$2" python3 -c '
import json, os, sys
try:
    value = json.loads(os.environ["JSON_DOCUMENT"])
    for part in os.environ["JSON_FIELD"].split("."):
        value = value[part]
except (KeyError, TypeError, ValueError):
    raise SystemExit(1)
if isinstance(value, bool) or not isinstance(value, (str, int)):
    raise SystemExit(1)
print(value)
'
}

fsync_path() {
  python3 - "$1" <<'PY'
import os, sys
path = sys.argv[1]
if os.path.isdir(path):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    descriptor = os.open(path, flags)
else:
    descriptor = os.open(path, os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

write_receipt() {
  local receipt_path="$1" state="$2" upload_id="$3" request_id="$4" object_etag="$5" object_bytes="$6" sha256="$7" claim_token="$8"
  PICKUP_CLAIM_TOKEN="$claim_token" python3 - "$receipt_path" "$state" "$upload_id" "$request_id" "$object_etag" "$object_bytes" "$sha256" <<'PY'
import json, os, sys, tempfile
path, state, upload_id, request_id, etag, size, digest = sys.argv[1:]
claim_token = os.environ["PICKUP_CLAIM_TOKEN"]
record = {
    "schemaVersion": 1,
    "state": state,
    "uploadId": upload_id,
    "requestId": request_id,
    "objectEtag": etag,
    "objectBytes": int(size),
    "sha256": digest,
    "pickupClaimToken": claim_token,
}
parent = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".receipt.", dir=parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(record, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
except BaseException:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
    raise
PY
}

receipt_field() {
  JSON_DOCUMENT=$(<"$1") JSON_FIELD="$2" python3 -c '
import json, os, sys
try:
    value = json.loads(os.environ["JSON_DOCUMENT"])[os.environ["JSON_FIELD"]]
except (KeyError, ValueError, TypeError):
    raise SystemExit(1)
if isinstance(value, bool) or not isinstance(value, (str, int)):
    raise SystemExit(1)
print(value)
'
}

post_internal_json() {
  local upload_id="$1" action="$2" payload="$3" config_file body_file status rc
  valid_upload_id "$upload_id" || return 1
  [[ "$action" =~ ^(accepted|pickup-status)$ ]] || return 1
  config_file=$(mktemp "$INCOMING_PICKUP_STATE_DIR/.pickup-curl.XXXXXX")
  body_file=$(mktemp "$INCOMING_PICKUP_STATE_DIR/.pickup-body.XXXXXX")
  INCOMING_PICKUP_SECRET="$INCOMING_PICKUP_SECRET" PICKUP_CALLBACK_PAYLOAD="$payload" python3 - "$config_file" "$body_file" \
    "$INCOMING_PICKUP_API_BASE/$upload_id/$action" <<'PY'
import json, os, sys
config, output, url = sys.argv[1:]
secret = os.environ["INCOMING_PICKUP_SECRET"]
payload = os.environ["PICKUP_CALLBACK_PAYLOAD"]
values = [
    "silent", "show-error", "max-redirs = 0", "connect-timeout = 10", "max-time = 30",
    'request = "POST"',
    f"header = {json.dumps('Authorization: Bearer ' + secret)}",
    'header = "Content-Type: application/json"', 'header = "Accept: application/json"',
    f"data-binary = {json.dumps(payload)}", f"output = {json.dumps(output)}",
    'write-out = "%{http_code}"', f"url = {json.dumps(url)}",
]
with open(config, "w", encoding="utf-8") as handle:
    handle.write("\n".join(values) + "\n")
os.chmod(config, 0o600)
PY
  set +e
  status=$(curl --config "$config_file")
  rc=$?
  set -e
  rm -f -- "$config_file" "$body_file"
  (( rc == 0 )) && [[ "$status" == "200" ]]
}

post_acceptance() {
  local upload_id="$1" digest="$2" claim_token="$3" payload
  valid_upload_id "$upload_id" || return 1
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || return 1
  valid_claim_token "$claim_token" || return 1
  payload=$(PICKUP_CLAIM_TOKEN="$claim_token" python3 -c 'import json,os,sys; print(json.dumps({"sha256":sys.argv[1],"claimToken":os.environ["PICKUP_CLAIM_TOKEN"]},separators=(",",":")))' "$digest")
  post_internal_json "$upload_id" accepted "$payload"
}

post_pickup_status() {
  local upload_id="$1" state="$2" claim_token="$3" retry_after="${4:-}" error_code="${5:-}" payload
  valid_upload_id "$upload_id" || return 1
  valid_claim_token "$claim_token" || return 1
  case "$state" in
    scanning)
      [[ -z "$retry_after$error_code" ]] || return 1
      payload=$(PICKUP_CLAIM_TOKEN="$claim_token" python3 -c 'import json,os; print(json.dumps({"state":"scanning","claimToken":os.environ["PICKUP_CLAIM_TOKEN"]},separators=(",",":")))')
      ;;
    heartbeat)
      [[ -z "$retry_after$error_code" ]] || return 1
      payload=$(PICKUP_CLAIM_TOKEN="$claim_token" python3 -c 'import json,os; print(json.dumps({"state":"heartbeat","claimToken":os.environ["PICKUP_CLAIM_TOKEN"]},separators=(",",":")))')
      ;;
    retry)
      valid_integer "$retry_after" && (( retry_after >= 60 && retry_after <= 86400 )) || return 1
      [[ "$error_code" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || return 1
      payload=$(PICKUP_CLAIM_TOKEN="$claim_token" python3 -c 'import json,os,sys; print(json.dumps({"state":"retry","claimToken":os.environ["PICKUP_CLAIM_TOKEN"],"retryAfterSeconds":int(sys.argv[1]),"errorCode":sys.argv[2]},separators=(",",":")))' "$retry_after" "$error_code")
      ;;
    *) return 1 ;;
  esac
  post_internal_json "$upload_id" pickup-status "$payload"
}

retry_marker_path() { printf '%s/retry-%s.json' "$INCOMING_PICKUP_STATE_DIR" "$1"; }

claim_marker_path() { printf '%s/claim-%s.json' "$INCOMING_PICKUP_STATE_DIR" "$1"; }

write_claim_marker() {
  local upload_id="$1" object_etag="$2" object_bytes="$3" claim_token="$4" marker
  marker=$(claim_marker_path "$upload_id")
  PICKUP_CLAIM_TOKEN="$claim_token" python3 - "$marker" "$object_etag" "$object_bytes" <<'PY'
import json, os, sys, tempfile
path, etag, size = sys.argv[1:]
token = os.environ["PICKUP_CLAIM_TOKEN"]
record = {"schemaVersion": 1, "objectEtag": etag, "objectBytes": int(size), "claimToken": token}
fd, temporary = tempfile.mkstemp(prefix=".claim.", dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(record, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
}

claim_token_for_identity() {
  local upload_id="$1" identity="$2" marker token
  marker=$(claim_marker_path "$upload_id")
  if [[ -f "$marker" ]]; then
    token=$(JSON_DOCUMENT=$(<"$marker") IDENTITY_DOCUMENT="$identity" python3 -c '
import json, os, re
try:
    marker = json.loads(os.environ["JSON_DOCUMENT"])
    identity = json.loads(os.environ["IDENTITY_DOCUMENT"])
    token = marker["claimToken"]
    matches = marker["objectEtag"] == identity["etag"] and marker["objectBytes"] == identity["bytes"]
except (KeyError, TypeError, ValueError):
    raise SystemExit(1)
if not matches or not isinstance(token, str) or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}", token):
    raise SystemExit(1)
print(token)
' 2>/dev/null || true)
    if valid_claim_token "$token"; then
      printf '%s\n' "$token"
      return 0
    fi
  fi
  new_claim_token
}

write_retry_marker() {
  local upload_id="$1" object_etag="$2" object_bytes="$3" delay_seconds="$4" error_code="$5" marker
  marker=$(retry_marker_path "$upload_id")
  python3 - "$marker" "$object_etag" "$object_bytes" "$delay_seconds" "$error_code" <<'PY'
import json, os, sys, tempfile, time
path, etag, size, delay, code = sys.argv[1:]
record = {"schemaVersion": 1, "objectEtag": etag, "objectBytes": int(size),
          "retryAfter": int(time.time()) + int(delay), "errorCode": code}
fd, temporary = tempfile.mkstemp(prefix=".retry.", dir=os.path.dirname(path))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(record, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY
}

retry_due() {
  local upload_id="$1" identity="$2" marker
  marker=$(retry_marker_path "$upload_id")
  [[ -f "$marker" ]] || return 0
  JSON_DOCUMENT=$(<"$marker") IDENTITY_DOCUMENT="$identity" INCOMING_PICKUP_MAX_SOURCE_BYTES="$INCOMING_PICKUP_MAX_SOURCE_BYTES" python3 -c '
import json, os, time
try:
    marker = json.loads(os.environ["JSON_DOCUMENT"])
    identity = json.loads(os.environ["IDENTITY_DOCUMENT"])
    due = (marker["objectEtag"] != identity["etag"] or marker["objectBytes"] != identity["bytes"]
           or marker["retryAfter"] <= int(time.time())
           or (marker["errorCode"] == "source_size_exceeded"
               and identity["bytes"] <= int(os.environ["INCOMING_PICKUP_MAX_SOURCE_BYTES"])))
except (KeyError, TypeError, ValueError):
    due = True
raise SystemExit(0 if due else 1)
'
}

report_retry() {
  local upload_id="$1" object_etag="$2" object_bytes="$3" claim_token="$4" delay_seconds="$5" error_code="$6"
  # Persist the due time even when the status callback is briefly unavailable;
  # otherwise an hourly job would repeatedly scan an unchanged failed object.
  write_retry_marker "$upload_id" "$object_etag" "$object_bytes" "$delay_seconds" "$error_code" || true
  post_pickup_status "$upload_id" retry "$claim_token" "$delay_seconds" "$error_code" || true
}

new_claim_token() {
  python3 -c 'import uuid; print(uuid.uuid4())'
}

claim_heartbeat_active() {
  [[ -n "$HEARTBEAT_STATE_FILE" && -f "$HEARTBEAT_STATE_FILE" ]] && [[ $(<"$HEARTBEAT_STATE_FILE") == "active" ]]
}

start_claim_heartbeat() {
  local upload_id="$1" claim_token="$2"
  HEARTBEAT_STATE_FILE="$CURRENT_STAGE/claim-heartbeat"
  printf 'active\n' >"$HEARTBEAT_STATE_FILE"
  chmod 600 -- "$HEARTBEAT_STATE_FILE"
  (
    while sleep 300; do
      if ! post_pickup_status "$upload_id" heartbeat "$claim_token"; then
        printf 'lost\n' >"$HEARTBEAT_STATE_FILE"
        exit 0
      fi
    done
  ) &
  HEARTBEAT_PID=$!
}

stop_claim_heartbeat() {
  if [[ -n "$HEARTBEAT_PID" ]]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  HEARTBEAT_PID=""
}

delete_exact_object() {
  # Keys are server-assigned and immutable after multipart completion.  The
  # caller heads it again immediately before this operation to prove the same
  # ETag/size it scanned; never call this for an arbitrary user-provided key.
  aws_r2 s3api delete-object --bucket "$INCOMING_PICKUP_R2_BUCKET" --key "$1" >/dev/null
}

head_object() {
  local key="$1" document
  document=$(aws_r2 s3api head-object --bucket "$INCOMING_PICKUP_R2_BUCKET" --key "$key") || return 1
  JSON_DOCUMENT="$document" python3 -c '
import json, os, re, sys
try:
    source = json.loads(os.environ["JSON_DOCUMENT"])
    size = source["ContentLength"]
    etag = source["ETag"].strip("\\\"")
    metadata = source.get("Metadata") or {}
    request_id = metadata["requestid"]
except (KeyError, AttributeError, TypeError, ValueError):
    raise SystemExit(1)
if isinstance(size, bool) or not isinstance(size, int) or size < 1:
    raise SystemExit(1)
if not re.fullmatch(r"[0-9a-fA-F-]{1,128}", etag):
    raise SystemExit(1)
if not re.fullmatch(r"[A-Za-z0-9_-]{8,200}", request_id):
    raise SystemExit(1)
print(json.dumps({"bytes":size,"etag":etag.lower(),"requestId":request_id}, separators=(",", ":")))
'
}

same_identity() {
  local current="$1" expected_etag="$2" expected_bytes="$3"
  JSON_DOCUMENT="$current" EXPECTED_ETAG="$expected_etag" EXPECTED_BYTES="$expected_bytes" python3 -c '
import json, os, sys
try:
    value = json.loads(os.environ["JSON_DOCUMENT"])
    ok = value["etag"] == os.environ["EXPECTED_ETAG"] and value["bytes"] == int(os.environ["EXPECTED_BYTES"])
except (KeyError, ValueError, TypeError):
    ok = False
raise SystemExit(0 if ok else 1)
'
}

scan_clean_file() {
  # `clamscan` may inspect an archive internally, but this worker never
  # extracts it, runs a renderer, or exposes its contents before the scan.
  timeout --signal=TERM --kill-after=30s "$INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS" \
    clamscan --no-summary --infected -- "$1" >/dev/null 2>&1
}

local_digest() { sha256sum -- "$1" | awk '{print tolower($1)}'; }

promote_and_accept() {
  local upload_id="$1" request_id="$2" key="$3" identity="$4"
  local object_etag object_bytes stage_file digest final_dir receipt claim_token
  PICKUP_ATTEMPTED=0
  object_etag=$(json_field "$identity" etag) || return 1
  object_bytes=$(json_field "$identity" bytes) || return 1
  [[ "$object_bytes" =~ ^[0-9]+$ ]] && (( object_bytes <= INCOMING_PICKUP_MAX_SOURCE_BYTES )) || {
    log "job deferred because the configured source-byte bound was exceeded"
    # The API permits a retry transition only after scanning has claimed the
    # current object.  This HEAD-only transition performs no source transfer,
    # but makes an over-limit object visibly operator-deferred and persists a
    # local due time so hourly listing does not starve later candidates.
    claim_token=$(claim_token_for_identity "$upload_id" "$identity") || return 1
    if post_pickup_status "$upload_id" scanning "$claim_token"; then
      write_claim_marker "$upload_id" "$object_etag" "$object_bytes" "$claim_token" || return 1
    else
      log "oversize deferral was not acknowledged; local retry remains bounded"
    fi
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" "$INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS" source_size_exceeded
    return 0
  }

  final_dir="$INCOMING_PICKUP_DESTINATION_DIR/$upload_id"
  receipt="$final_dir/receipt.json"
  if [[ -e "$final_dir" ]]; then
    # A prior run may have completed the durable local promotion but stopped
    # before deleting R2 or posting its idempotent receipt.  Do not re-scan,
    # overwrite, or blindly trust it; recovery verifies its immutable receipt.
    recover_one "$final_dir" "$key" "$identity"
    return 0
  fi

  # Do not read a quarantined byte until Operations acknowledges this attempt.
  # The status transition is also a fail-closed freshness check for an upload
  # that may have been accepted, expired, or removed since this R2 listing.
  claim_token=$(claim_token_for_identity "$upload_id" "$identity") || return 1
  if ! post_pickup_status "$upload_id" scanning "$claim_token"; then
    log "pickup attempt was not acknowledged; object left for retry"
    return 0
  fi
  write_claim_marker "$upload_id" "$object_etag" "$object_bytes" "$claim_token" || {
    log "pickup claim could not be persisted; source remains unread"
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 claim_persistence_failed
    return 0
  }

  CURRENT_STAGE=$(mktemp -d "$INCOMING_PICKUP_STAGING_DIR/job.XXXXXXXX")
  chmod 700 -- "$CURRENT_STAGE"
  stage_file="$CURRENT_STAGE/payload"
  start_claim_heartbeat "$upload_id" "$claim_token"
  # This cap intentionally counts source transfer starts, rather than listing
  # slots. Deferred, malformed, or not-yet-due keys must not block later keys.
  PICKUP_ATTEMPTED=1
  if ! aws_r2 s3api get-object --bucket "$INCOMING_PICKUP_R2_BUCKET" --key "$key" "$stage_file" >/dev/null; then
    log "source download failed; object left for retry"
    stop_claim_heartbeat
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 source_transfer_failed
    return 0
  fi
  chmod 600 -- "$stage_file"
  local actual_bytes
  actual_bytes=$(stat -c '%s' -- "$stage_file")
  if [[ "$actual_bytes" != "$object_bytes" ]]; then
    log "source identity mismatch; object left for retry"
    stop_claim_heartbeat
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 source_identity_mismatch
    return 0
  fi
  local scan_rc=0
  scan_clean_file "$stage_file" || scan_rc=$?
  if (( scan_rc != 0 )); then
    # An infected file, scanner failure, or timeout is never promoted or
    # deleted.  An operator must inspect the bounded log and source quarantine.
    log "scan did not pass; object left quarantined"
    stop_claim_heartbeat
    if (( scan_rc == 1 )); then
      report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 86400 scan_rejected
    else
      report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 scan_unavailable
    fi
    return 0
  fi
  digest=$(local_digest "$stage_file")
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || { log "checksum calculation failed; object left for retry"; stop_claim_heartbeat; report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 checksum_failed; return 0; }
  if ! fsync_path "$stage_file"; then
    log "local payload could not be made durable; object left for retry"
    stop_claim_heartbeat
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 local_durability_failed
    return 0
  fi
  if ! write_receipt "$CURRENT_STAGE/receipt.json" "promoted" "$upload_id" "$request_id" "$object_etag" "$object_bytes" "$digest" "$claim_token"; then
    log "local receipt could not be written; object left for retry"
    stop_claim_heartbeat
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 local_receipt_failed
    return 0
  fi
  if ! fsync_path "$CURRENT_STAGE"; then
    log "local promotion state could not be made durable; object left for retry"
    stop_claim_heartbeat
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 local_durability_failed
    return 0
  fi

  # Prove the object we scanned is still the same complete immutable object
  # before the atomic local rename and irreversible R2 delete.
  local after_scan
  after_scan=$(head_object "$key") || { log "source disappeared before promotion; local stage discarded"; stop_claim_heartbeat; report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 source_identity_unavailable; return 0; }
  same_identity "$after_scan" "$object_etag" "$object_bytes" || { log "source changed before promotion; object left for retry"; stop_claim_heartbeat; report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 source_identity_changed; return 0; }
  # Stop the writer before examining its fail-closed state, otherwise a late
  # heartbeat failure could race a delete after we observed it as active.
  stop_claim_heartbeat
  if ! claim_heartbeat_active; then
    log "pickup lease could not be renewed; object left for retry"
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 pickup_lease_lost
    return 0
  fi
  rm -f -- "$HEARTBEAT_STATE_FILE"
  HEARTBEAT_STATE_FILE=""

  if ! mv -- "$CURRENT_STAGE" "$final_dir"; then
    log "local promotion could not be completed; object left for retry"
    report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 local_promotion_failed
    return 0
  fi
  CURRENT_STAGE=""
  fsync_path "$INCOMING_PICKUP_DESTINATION_DIR"
  recover_one "$final_dir" "$key" "$after_scan"
}

recover_one() {
  local final_dir="$1" key="$2" listed_identity="${3:-}" receipt payload upload_id request_id object_etag object_bytes digest claim_token current
  receipt="$final_dir/receipt.json"
  payload="$final_dir/payload"
  [[ -f "$receipt" && -f "$payload" ]] || { log "local promotion state is incomplete; object left quarantined"; return 0; }
  upload_id=$(receipt_field "$receipt" uploadId 2>/dev/null || true)
  request_id=$(receipt_field "$receipt" requestId 2>/dev/null || true)
  object_etag=$(receipt_field "$receipt" objectEtag 2>/dev/null || true)
  object_bytes=$(receipt_field "$receipt" objectBytes 2>/dev/null || true)
  digest=$(receipt_field "$receipt" sha256 2>/dev/null || true)
  claim_token=$(receipt_field "$receipt" pickupClaimToken 2>/dev/null || true)
  [[ $(receipt_field "$receipt" state 2>/dev/null || true) == "promoted" ]] || return 0
  valid_upload_id "$upload_id" && valid_upload_id "$request_id" && [[ "$object_etag" =~ ^[0-9a-f-]{1,128}$ ]] &&
    [[ "$object_bytes" =~ ^[0-9]+$ ]] && [[ "$digest" =~ ^[a-f0-9]{64}$ ]] && valid_claim_token "$claim_token" || {
      log "local promotion receipt is invalid; object left quarantined"
      return 0
    }
  # Recovery scans local promotion receipts too.  Reconstruct only the
  # server-owned key format from separately validated receipt fields; never
  # accept a key read from local input or ask Operations to waive its R2 check.
  if [[ -z "$key" ]]; then
    key="quarantine/$request_id/$upload_id/object"
  fi
  [[ $(stat -c '%s' -- "$payload") == "$object_bytes" ]] && [[ $(local_digest "$payload") == "$digest" ]] || {
    log "local promotion integrity check failed; object left quarantined"
    return 0
  }

  # If the object is still present, it must remain the exact object already
  # scanned.  A missing object is the expected crash-recovery state after an
  # earlier successful delete; in that case only the idempotent receipt remains.
  if current=$(head_object "$key" 2>/dev/null); then
    same_identity "$current" "$object_etag" "$object_bytes" || {
      log "source identity changed after local promotion; no delete or receipt"
      return 0
    }
    if ! delete_exact_object "$key"; then
      log "source delete failed after durable promotion; receipt deferred"
      report_retry "$upload_id" "$object_etag" "$object_bytes" "$claim_token" 300 source_delete_failed
      return 0
    fi
  elif [[ -n "$listed_identity" ]]; then
    log "source could not be rechecked; receipt deferred"
    return 0
  fi

  if post_acceptance "$upload_id" "$digest" "$claim_token"; then
    write_receipt "$receipt" "accepted" "$upload_id" "$request_id" "$object_etag" "$object_bytes" "$digest" "$claim_token"
    rm -f -- "$(retry_marker_path "$upload_id")"
    rm -f -- "$(claim_marker_path "$upload_id")"
    log "upload accepted after clean verified promotion"
  else
    # The local receipt stays promoted.  The next run will only retry the
    # idempotent receipt; it never deletes or rescans the source a second time.
    log "acceptance receipt deferred for retry"
  fi
}

recover_promotions() {
  local receipt
  while IFS= read -r -d '' receipt; do
    local final_dir
    final_dir=$(dirname -- "$receipt")
    [[ $(receipt_field "$receipt" state 2>/dev/null || true) == "promoted" ]] || continue
    recover_one "$final_dir" "" ""
  done < <(find "$INCOMING_PICKUP_DESTINATION_DIR" -mindepth 2 -maxdepth 2 -type f -name receipt.json -print0)
}

list_candidates_page() {
  local continuation="${1:-}" document
  local -a arguments=(s3api list-objects-v2 --bucket "$INCOMING_PICKUP_R2_BUCKET" --prefix quarantine/ --max-keys "$LIST_PAGE_SIZE")
  if [[ -n "$continuation" ]]; then
    [[ ${#continuation} -le 4096 && "$continuation" != *$'\r'* && "$continuation" != *$'\n'* ]] || return 1
    arguments+=(--continuation-token "$continuation")
  fi
  document=$(aws_r2 "${arguments[@]}") || return 1
  LIST_NEXT_TOKEN=$(JSON_DOCUMENT="$document" python3 -c '
import json, os
try:
    value = json.loads(os.environ["JSON_DOCUMENT"])
    token = value.get("NextContinuationToken")
except (AttributeError, ValueError):
    raise SystemExit(1)
if token is None:
    print("")
elif isinstance(token, str) and token and len(token) <= 4096 and "\r" not in token and "\n" not in token:
    print(token)
else:
    raise SystemExit(1)
') || return 1
  JSON_DOCUMENT="$document" python3 -c '
import json, os, re, sys
try:
    contents = json.loads(os.environ["JSON_DOCUMENT"]).get("Contents", [])
except ValueError:
    raise SystemExit(1)
if not isinstance(contents, list):
    raise SystemExit(1)
for value in contents:
    if not isinstance(value, dict):
        continue
    key, size = value.get("Key"), value.get("Size")
    match = re.fullmatch(r"quarantine/([A-Za-z0-9_-]{8,200})/([A-Za-z0-9_-]{8,200})/object", key or "")
    if not match or isinstance(size, bool) or not isinstance(size, int) or size < 1:
        continue
    print(f"{match.group(1)}\t{match.group(2)}\t{key}")
'
}

run_once() {
  recover_promotions
  local request_id upload_id key identity continuation="" attempts=0
  while (( attempts < INCOMING_PICKUP_MAX_JOBS )); do
    CURRENT_LIST_FILE=$(mktemp "$INCOMING_PICKUP_STATE_DIR/.pickup-list.XXXXXX")
    if ! list_candidates_page "$continuation" >"$CURRENT_LIST_FILE"; then
      log "candidate page listing failed; remaining objects left for retry"
      rm -f -- "$CURRENT_LIST_FILE"
      CURRENT_LIST_FILE=""
      return 0
    fi
    while IFS=$'\t' read -r request_id upload_id key; do
      (( attempts < INCOMING_PICKUP_MAX_JOBS )) || break
      valid_upload_id "$request_id" && valid_upload_id "$upload_id" || continue
      identity=$(head_object "$key") || { log "candidate head check failed; object left for retry"; continue; }
      [[ $(json_field "$identity" requestId 2>/dev/null || true) == "$request_id" ]] || {
        log "candidate metadata did not match its server key; object left quarantined"
        continue
      }
      if ! retry_due "$upload_id" "$identity"; then
        log "candidate retry remains deferred"
        continue
      fi
      if ! promote_and_accept "$upload_id" "$request_id" "$key" "$identity"; then
        log "candidate processing failed before source transfer; object left for retry"
      fi
      (( PICKUP_ATTEMPTED == 1 )) && (( attempts += 1 ))
    done < "$CURRENT_LIST_FILE"
    rm -f -- "$CURRENT_LIST_FILE"
    CURRENT_LIST_FILE=""
    (( attempts < INCOMING_PICKUP_MAX_JOBS )) || break
    continuation="$LIST_NEXT_TOKEN"
    [[ -n "$continuation" ]] || break
  done
}

case "${1:---once}" in
  --once) ;;
  *) die "usage: $0 [--once]" ;;
esac

log "worker started (bounded hourly pickup)"
run_once
log "worker finished"
