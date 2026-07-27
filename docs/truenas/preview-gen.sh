#!/usr/bin/env bash
#
# Canonical LTDS TrueNAS preview generator.
#
# Generates:
#   images: thumb.webp, preview.webp, manifest.json
#   videos: poster.webp, manifest.json
#   PDFs:   thumb.webp, preview.webp, manifest.json
#
# Artifacts are written beside each source under:
#   .previews/<sha256-of-NFC-leaf-including-extension>/

set -euo pipefail

DRY_RUN=false
SINGLE_FILE=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
elif [[ "${1:-}" == "--single" ]]; then
  SINGLE_FILE="${2:-}"
fi

JOBS_ROOT="${JOBS_ROOT:-/data/jobs}"
R2_ROOT_PREFIX="${R2_ROOT_PREFIX:-Jobs}"
PRODUCER_VERSION="ltds-preview/2.0.0"

SCAN_DIRS=()
if [[ -d "${JOBS_ROOT}/Clients" ]]; then
  SCAN_DIRS+=("${JOBS_ROOT}/Clients")
fi
for directory in "Demo" "Edited Vs. Nonedited" "Extended"; do
  if [[ -d "${JOBS_ROOT}/${directory}" ]]; then
    SCAN_DIRS+=("${JOBS_ROOT}/${directory}")
  fi
done

THUMB_W=520
THUMB_H=340
THUMB_MAX_BYTES=102400
THUMB_START_Q=72
PREVIEW_MAX_W=2400
PREVIEW_MAX_H=1800
PREVIEW_MAX_BYTES=512000
PREVIEW_START_Q=84
QUALITY_LADDER=(84 72 66 60 54 48 42 36 30)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

get_ext() {
  local name="${1##*/}"
  printf '%s\n' "${name##*.}" | tr '[:upper:]' '[:lower:]'
}

file_size() {
  stat -c %s "$1" 2>/dev/null || echo 0
}

source_identity() {
  stat -Lc '%d:%i:%s:%Y' "$1" 2>/dev/null || echo "unavailable"
}

allowed_source_path() {
  local src="$1" root resolved relative segment lower
  local -a segments
  root=$(realpath -e "$JOBS_ROOT" 2>/dev/null) || return 1
  resolved=$(realpath -e "$src" 2>/dev/null) || return 1
  [[ "$resolved" == "$root/"* ]] || return 1
  relative="${resolved#"$root/"}"
  IFS='/' read -r -a segments <<< "$relative"
  for segment in "${segments[@]}"; do
    lower=$(printf '%s' "$segment" | tr '[:upper:]' '[:lower:]')
    case "$lower" in
      dump|map|model|archive|.previews|_ltds) return 1 ;;
    esac
    [[ "$segment" == .* ]] && return 1
  done
  return 0
}

sha256_name() {
  local leaf="${1##*/}"
  if command -v uconv >/dev/null 2>&1; then
    printf '%s' "$leaf" | uconv -x any-nfc | sha256sum | awk '{print $1}'
  else
    printf '%s' "$leaf" | sha256sum | awk '{print $1}'
  fi
}

has_previews() {
  local src="$1" dir leaf sha preview_dir manifest size mtime ext
  dir=$(dirname "$src")
  leaf="${src##*/}"
  sha=$(sha256_name "$leaf")
  preview_dir="${dir}/.previews/${sha}"
  manifest="${preview_dir}/manifest.json"
  size=$(file_size "$src")
  mtime=$(stat -c %Y "$src" 2>/dev/null || echo 0)
  ext=$(get_ext "$src")
  [[ -f "$manifest" ]] || return 1
  grep -Fq "\"producerVersion\": \"${PRODUCER_VERSION}\"" "$manifest" || return 1
  grep -Fq "\"sourceSize\": ${size}" "$manifest" || return 1
  grep -Fq "\"sourceModifiedEpoch\": ${mtime}" "$manifest" || return 1
  case "$ext" in
    mp4|mov|m4v|webm) [[ -s "${preview_dir}/poster.webp" ]] ;;
    *) [[ -s "${preview_dir}/thumb.webp" && -s "${preview_dir}/preview.webp" ]] ;;
  esac
}

encode_webp() {
  local src="$1" out="$2" max_bytes="$3" start_q="$4" filter="$5"
  local q tmp size dimensions width height scale_width new_width new_height new_filter

  for q in "${QUALITY_LADDER[@]}"; do
    ((q > start_q)) && continue
    tmp="${out}.tmp"
    if ffmpeg -hide_banner -loglevel error -y \
      -autorotate -i "$src" \
      -vf "$filter" \
      -frames:v 1 \
      -c:v libwebp -q:v "$q" \
      -an -sn -dn \
      -map_metadata -1 \
      -f webp \
      "$tmp" 2>/dev/null; then
      size=$(file_size "$tmp")
      if ((size <= max_bytes && size > 0)); then
        mv "$tmp" "$out"
        dimensions=$(ffprobe -v error -select_streams v:0 \
          -show_entries stream=width,height -of csv=p=0 "$out" 2>/dev/null || echo "? ?")
        width=$(printf '%s' "$dimensions" | cut -d, -f1)
        height=$(printf '%s' "$dimensions" | cut -d, -f2)
        echo "${width:-?} ${height:-?} $size $q"
        return 0
      fi
      rm -f "$tmp"
    fi
  done

  if [[ "$filter" == *"scale="* ]]; then
    scale_width=$(printf '%s' "$filter" | sed -n 's/.*scale=\([0-9][0-9]*\).*/\1/p' | head -1)
    if [[ -n "$scale_width" ]] && ((scale_width > 100)); then
      new_width=$((scale_width * 9 / 10))
      if [[ "$filter" == *"force_original_aspect_ratio=decrease"* ]]; then
        new_filter="scale=${new_width}:-1:force_original_aspect_ratio=decrease"
      else
        new_height=$((THUMB_H * new_width / THUMB_W))
        new_filter="scale=${new_width}:${new_height}:force_original_aspect_ratio=increase,crop=${new_width}:${new_height}:(iw-${new_width})/2:(ih-${new_height})/2"
      fi
      encode_webp "$src" "$out" "$max_bytes" "$start_q" "$new_filter"
      return $?
    fi
  fi
  return 1
}

generate_thumb() {
  local src="$1" out="$2"
  local filter="scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H}:(iw-${THUMB_W})/2:(ih-${THUMB_H})/2"
  encode_webp "$src" "$out" "$THUMB_MAX_BYTES" "$THUMB_START_Q" "$filter"
}

generate_preview() {
  local src="$1" out="$2"
  local filter="scale=${PREVIEW_MAX_W}:${PREVIEW_MAX_H}:force_original_aspect_ratio=decrease"
  encode_webp "$src" "$out" "$PREVIEW_MAX_BYTES" "$PREVIEW_START_Q" "$filter"
}

generate_poster() {
  local src="$1" out="$2" duration frame_time percentage frame poster_info
  duration=$(ffprobe -v error -show_entries format=duration \
    -of default=noprint_wrappers=1:nokey=1 "$src" 2>/dev/null || echo "0")
  if [[ -z "$duration" || "$duration" == "0" || "$duration" == "N/A" ]]; then
    duration=10
  fi

  for percentage in 10 25 50 75; do
    frame_time=$(awk "BEGIN {t=$duration * $percentage / 100; if (t < 1) t=1; if (t > $duration - 1) t=$duration - 1; printf \"%.1f\", t}")
    frame=$(mktemp /tmp/ltds-poster-XXXXXX.png)
    if ffmpeg -hide_banner -loglevel error -y \
      -ss "$frame_time" -i "$src" \
      -frames:v 1 -an -sn -dn -map_metadata -1 "$frame" 2>/dev/null; then
      if poster_info=$(generate_thumb "$frame" "$out"); then
        rm -f "$frame"
        echo "$poster_info"
        return 0
      fi
    fi
    rm -f "$frame"
  done
  return 1
}

generate_pdf_previews() {
  local src="$1" thumb_out="$2" preview_out="$3" base png thumb_info preview_info
  base=$(mktemp /tmp/pdf-XXXXXX)
  if ! pdftoppm -f 1 -l 1 -r 150 -png "$src" "$base" 2>/dev/null; then
    rm -f "${base}"* 2>/dev/null
    return 1
  fi
  png="${base}-1.png"
  [[ -f "$png" ]] || png="${base}.png"
  if [[ ! -f "$png" ]]; then
    rm -f "${base}"* 2>/dev/null
    return 1
  fi
  thumb_info=$(generate_thumb "$png" "$thumb_out") || {
    rm -f "${base}"*
    return 1
  }
  preview_info=$(generate_preview "$png" "$preview_out") || {
    rm -f "${base}"*
    return 1
  }
  rm -f "${base}"* 2>/dev/null
  echo "$thumb_info"
  echo "$preview_info"
}

safe_json_path() {
  local value="$1"
  [[ "$value" != *$'\n'* &&
    "$value" != *$'\r'* &&
    "$value" != *$'\t'* &&
    "$value" != *'"'* &&
    "$value" != *'\'* ]]
}

write_manifest() {
  local dir="$1" source_key="$2" source_size="$3" source_mtime="$4" artifact_prefix="$5"
  shift 5
  local now derivatives="" first=1 dtype width height bytes quality numeric manifest_tmp
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  safe_json_path "$source_key" || {
    log "  ERROR: unsupported characters in source path: $source_key"
    return 1
  }
  safe_json_path "$artifact_prefix" || {
    log "  ERROR: unsupported characters in artifact path: $artifact_prefix"
    return 1
  }

  while (($# > 0)); do
    dtype="$1"
    width="$2"
    height="$3"
    bytes="$4"
    quality="$5"
    shift 5
    [[ "$dtype" =~ ^(thumb|preview|poster)$ ]] || return 1
    for numeric in "$width" "$height" "$bytes" "$quality"; do
      [[ "$numeric" =~ ^[0-9]+$ && "$numeric" -gt 0 ]] || return 1
    done
    ((first == 1)) || derivatives+=","
    first=0
    derivatives+=$'\n    '"\"$dtype\": {"
    derivatives+=$'\n      '"\"key\": \"${artifact_prefix}/${dtype}.webp\","
    derivatives+=$'\n      '"\"mime\": \"image/webp\","
    derivatives+=$'\n      '"\"width\": $width,"
    derivatives+=$'\n      '"\"height\": $height,"
    derivatives+=$'\n      '"\"bytes\": $bytes,"
    derivatives+=$'\n      '"\"quality\": $quality"
    derivatives+=$'\n    }'
  done

  manifest_tmp="${dir}/manifest.json.tmp"
  cat >"$manifest_tmp" <<MANIFEST
{
  "sourceKey": "${source_key}",
  "sourceEtag": "pending",
  "sourceSize": ${source_size},
  "sourceModifiedEpoch": ${source_mtime},
  "producerVersion": "${PRODUCER_VERSION}",
  "createdAt": "${now}",
  "finalizationStatus": "pending-r2",
  "derivatives": {${derivatives}
  }
}
MANIFEST
  mv "$manifest_tmp" "${dir}/manifest.json"
}

process_file() (
  local src="$1" dir leaf sha file_type ext preview_dir work_dir lock_dir backup_dir
  local file_bytes identity_before source_key local_relative artifact_prefix source_mtime
  local -a manifest_args

  allowed_source_path "$src" || {
    log "  ERROR: source is outside the permitted Jobs tree: $src"
    return 1
  }
  src=$(realpath -e "$src")
  dir=$(dirname "$src")
  leaf="${src##*/}"
  sha=$(sha256_name "$leaf")
  preview_dir="${dir}/.previews/${sha}"
  ext=$(get_ext "$src")

  case "$ext" in
    jpg|jpeg|png|tiff|tif|webp|gif|bmp|avif|heic|heif) file_type="image" ;;
    mp4|mov|m4v|webm) file_type="video" ;;
    pdf) file_type="pdf" ;;
    *) return 0 ;;
  esac

  file_bytes=$(file_size "$src")
  ((file_bytes > 0)) || return 0
  has_previews "$src" && return 99
  identity_before=$(source_identity "$src")
  [[ "$identity_before" != "unavailable" ]] || return 1

  local_relative="${src#${JOBS_ROOT}/}"
  source_key="${R2_ROOT_PREFIX%/}/${local_relative}"
  artifact_prefix="$(dirname "$source_key")/.previews/${sha}"
  source_mtime=$(stat -c %Y "$src" 2>/dev/null || echo 0)

  if [[ "$DRY_RUN" == "true" ]]; then
    log "  WOULD GEN: $file_type -> $src -> $preview_dir"
    return 0
  fi

  mkdir -p "${dir}/.previews/.locks"
  lock_dir="${dir}/.previews/.locks/${sha}.lock"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    log "  SKIP: another process is already generating ${leaf}"
    return 99
  fi
  work_dir="${dir}/.previews/.${sha}.tmp.$$"
  backup_dir="${dir}/.previews/.${sha}.old.$$"
  trap '[[ -n "${work_dir:-}" ]] && rm -rf -- "$work_dir"; [[ -n "${backup_dir:-}" ]] && rm -rf -- "$backup_dir"; [[ -n "${lock_dir:-}" ]] && rm -rf -- "$lock_dir"' EXIT
  rm -rf "$work_dir" "$backup_dir"
  mkdir -p "$work_dir"
  manifest_args=()

  case "$file_type" in
    image)
      local thumb preview thumb_info preview_info
      thumb="${work_dir}/thumb.webp"
      preview="${work_dir}/preview.webp"
      thumb_info=$(generate_thumb "$src" "$thumb") || {
        log "  ERROR: thumb failed for $src"
        return 1
      }
      preview_info=$(generate_preview "$src" "$preview") || {
        log "  ERROR: preview failed for $src"
        return 1
      }
      manifest_args=(
        thumb $(echo "$thumb_info" | awk '{print $1, $2, $3, $4}')
        preview $(echo "$preview_info" | awk '{print $1, $2, $3, $4}')
      )
      ;;
    video)
      local poster poster_info
      poster="${work_dir}/poster.webp"
      poster_info=$(generate_poster "$src" "$poster") || {
        log "  ERROR: poster failed for $src"
        return 1
      }
      manifest_args=(poster $(echo "$poster_info" | awk '{print $1, $2, $3, $4}'))
      ;;
    pdf)
      local thumb preview results thumb_info preview_info
      thumb="${work_dir}/thumb.webp"
      preview="${work_dir}/preview.webp"
      results=$(generate_pdf_previews "$src" "$thumb" "$preview") || {
        log "  ERROR: PDF failed for $src"
        return 1
      }
      thumb_info=$(echo "$results" | head -1)
      preview_info=$(echo "$results" | tail -1)
      manifest_args=(
        thumb $(echo "$thumb_info" | awk '{print $1, $2, $3, $4}')
        preview $(echo "$preview_info" | awk '{print $1, $2, $3, $4}')
      )
      ;;
  esac

  write_manifest "$work_dir" "$source_key" "$file_bytes" "$source_mtime" \
    "$artifact_prefix" "${manifest_args[@]}" || {
    log "  ERROR: manifest failed for $src"
    return 1
  }
  if [[ "$(source_identity "$src")" != "$identity_before" ]]; then
    log "  RETRY: source changed during generation: $src"
    return 1
  fi
  [[ ! -d "$preview_dir" ]] || mv "$preview_dir" "$backup_dir"
  if ! mv "$work_dir" "$preview_dir"; then
    [[ -d "$backup_dir" ]] && mv "$backup_dir" "$preview_dir"
    return 1
  fi
  work_dir=""
  rm -rf "$backup_dir"
  backup_dir=""
  log "  DONE: ${leaf} -> ${preview_dir}"
  return 0
)

main() {
  local generated=0 skipped=0 errors=0 scan_dir src base result
  log "Preview generator ${PRODUCER_VERSION} started. Dry run: $DRY_RUN"
  log "Scan dirs: ${SCAN_DIRS[*]}"
  if ! command -v uconv >/dev/null 2>&1; then
    log "NOTICE: uconv is unavailable; filename hashing uses raw UTF-8 (ASCII filenames are unaffected)."
  fi

  if [[ -n "$SINGLE_FILE" ]]; then
    if [[ ! -f "$SINGLE_FILE" ]]; then
      log "ERROR: file not found: $SINGLE_FILE"
      return 1
    fi
    process_file "$SINGLE_FILE"
    return $?
  fi

  for scan_dir in "${SCAN_DIRS[@]}"; do
    log "Scanning: $scan_dir"
    while IFS= read -r -d '' src; do
      [[ -n "$src" ]] || continue
      base="${src##*/}"
      [[ "$base" != .* ]] || continue
      case "$src" in
        */.*) continue ;;
      esac
      result=0
      process_file "$src" || result=$?
      if [[ $result -eq 99 ]]; then
        skipped=$((skipped + 1))
      elif [[ $result -eq 0 ]]; then
        generated=$((generated + 1))
      else
        errors=$((errors + 1))
      fi
    done < <(
      find "$scan_dir" -xdev \
        -type d -iname "dump" -prune -o \
        -type d -iname "map" -prune -o \
        -type d -iname "model" -prune -o \
        -type d -name ".previews" -prune -o \
        -type d -iname "archive" -prune -o \
        -type d -name ".*" -prune -o \
        -type f -print0 2>/dev/null || true
    )
  done
  log ""
  log "Summary: generated=$generated, skipped=$skipped, errors=$errors"
  ((errors == 0))
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
