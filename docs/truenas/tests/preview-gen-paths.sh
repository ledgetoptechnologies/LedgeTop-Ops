#!/usr/bin/env bash

set -euo pipefail

TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="${TEST_DIR}/../preview-gen.sh"
output=""
status=0
output=$(bash "$SCRIPT" 2>&1) || status=$?

[[ "$status" -eq 2 ]]
grep -Fq "server-side preview generation is retired" <<<"$output"
grep -Fq "Cloudflare Queues" <<<"$output"

echo "retired preview generator guard passed"
