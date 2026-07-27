#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="${TEST_DIR}/../preview-gen.sh"
FIXTURE_PARENT=$(mktemp -d)
FIXTURE_ROOT="${FIXTURE_PARENT}/jobs"
trap 'rm -rf "$FIXTURE_PARENT"' EXIT

mkdir -p \
  "${FIXTURE_ROOT}/Clients/Acme/Current Projects/Site/Deliverables/Photos" \
  "${FIXTURE_ROOT}/Demo" \
  "${FIXTURE_ROOT}/Edited Vs. Nonedited" \
  "${FIXTURE_ROOT}/Extended" \
  "${FIXTURE_ROOT}/Clients/Acme/Dump" \
  "${FIXTURE_ROOT}/Clients/Acme/MAP" \
  "${FIXTURE_ROOT}/Clients/Acme/Model" \
  "${FIXTURE_ROOT}/Clients/Acme/Archive" \
  "${FIXTURE_ROOT}/Clients/Acme/.previews/hash" \
  "${FIXTURE_ROOT}/Clients/Acme/_ltds" \
  "${FIXTURE_ROOT}/Clients/Acme/.hidden"

touch \
  "${FIXTURE_ROOT}/Clients/Acme/Current Projects/Site/Deliverables/Photos/photo.jpg" \
  "${FIXTURE_ROOT}/Demo/demo.mov" \
  "${FIXTURE_ROOT}/Edited Vs. Nonedited/example.jpg" \
  "${FIXTURE_ROOT}/Extended/example.pdf" \
  "${FIXTURE_ROOT}/Clients/Acme/Dump/rejected.jpg" \
  "${FIXTURE_ROOT}/Clients/Acme/MAP/rejected.jpg" \
  "${FIXTURE_ROOT}/Clients/Acme/Model/rejected.jpg" \
  "${FIXTURE_ROOT}/Clients/Acme/Archive/rejected.jpg" \
  "${FIXTURE_ROOT}/Clients/Acme/.previews/hash/rejected.webp" \
  "${FIXTURE_ROOT}/Clients/Acme/_ltds/rejected.jpg" \
  "${FIXTURE_ROOT}/Clients/Acme/.hidden/rejected.jpg" \
  "${FIXTURE_PARENT}/outside.jpg"

JOBS_ROOT="$FIXTURE_ROOT"
# shellcheck source=../preview-gen.sh
source "$SCRIPT"

expect_allowed() {
  local path="$1"
  if ! allowed_source_path "$path"; then
    echo "Expected allowed path: $path" >&2
    return 1
  fi
}

expect_rejected() {
  local path="$1"
  if allowed_source_path "$path"; then
    echo "Expected rejected path: $path" >&2
    return 1
  fi
}

expect_allowed "${FIXTURE_ROOT}/Clients/Acme/Current Projects/Site/Deliverables/Photos/photo.jpg"
expect_allowed "${FIXTURE_ROOT}/Demo/demo.mov"
expect_allowed "${FIXTURE_ROOT}/Edited Vs. Nonedited/example.jpg"
expect_allowed "${FIXTURE_ROOT}/Extended/example.pdf"

expect_rejected "${FIXTURE_ROOT}/Clients/Acme/Dump/rejected.jpg"
expect_rejected "${FIXTURE_ROOT}/Clients/Acme/MAP/rejected.jpg"
expect_rejected "${FIXTURE_ROOT}/Clients/Acme/Model/rejected.jpg"
expect_rejected "${FIXTURE_ROOT}/Clients/Acme/Archive/rejected.jpg"
expect_rejected "${FIXTURE_ROOT}/Clients/Acme/.previews/hash/rejected.webp"
expect_rejected "${FIXTURE_ROOT}/Clients/Acme/_ltds/rejected.jpg"
expect_rejected "${FIXTURE_ROOT}/Clients/Acme/.hidden/rejected.jpg"
expect_rejected "${FIXTURE_PARENT}/outside.jpg"

MANIFEST_DIR="${FIXTURE_PARENT}/manifest"
mkdir -p "$MANIFEST_DIR"
write_manifest \
  "$MANIFEST_DIR" \
  "Jobs/Clients/Acme/photo.jpg" \
  "123456" \
  "1774569600" \
  "Jobs/Clients/Acme/.previews/abc123" \
  thumb 520 340 90000 72 \
  preview 2400 1800 450000 84

MANIFEST="${MANIFEST_DIR}/manifest.json"
grep -Fq '"producerVersion": "ltds-preview/2.0.0"' "$MANIFEST"
grep -Fq '"sourceEtag": "pending"' "$MANIFEST"
grep -Fq '"finalizationStatus": "pending-r2"' "$MANIFEST"
grep -Fq '"sourceSize": 123456' "$MANIFEST"
grep -Fq '"sourceModifiedEpoch": 1774569600' "$MANIFEST"
grep -Fq '"key": "Jobs/Clients/Acme/.previews/abc123/thumb.webp"' "$MANIFEST"
grep -Fq '"key": "Jobs/Clients/Acme/.previews/abc123/preview.webp"' "$MANIFEST"

echo "preview-gen path and v2 manifest fixtures passed"
