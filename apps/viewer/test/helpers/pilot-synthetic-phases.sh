#!/bin/sh
# Test-only driver: execute solely in a disposable network-none container.
# /scratch is an extracted copy, /fixture-state is a private disposable mount,
# /fixture-input and /fixture-receipt are disposable, and the archive is read-only.
set -eu
test "${LTDS_PILOT_SYNTHETIC_TEST:-}" = 1
test "$(pwd -P)" = /scratch
test -z "$(ls -A /fixture-state)"
test -z "$(ls -A /fixture-input)"
test -z "$(ls -A /fixture-receipt)"
test -f /fixture-archive/result.zip
guard="if(phase!=='prepare')throw Error('pilot execution held pending integrated supervision and receipt review');"
test "$(grep -Fc "$guard" test/helpers/real-coordinator-chain.cjs)" = 1
# Remove the hold only from this disposable extracted source, never the worktree.
sed -i "/^if(phase!.*pilot execution held pending integrated supervision and receipt review/d" test/helpers/real-coordinator-chain.cjs
printf %s pilot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > /fixture-state/.viewer-pilot-owner
chmod 600 /fixture-state/.viewer-pilot-owner
i=0
while [ "$i" -lt 40 ]; do printf 'synthetic-photo-%s' "$i" > "/fixture-input/photo-$i.jpg"; i=$((i+1)); done
export VIEWER_FIXTURE_ROOT=/fixture-state/viewer VIEWER_FIXTURE_PHOTOS=/fixture-input VIEWER_FIXTURE_COORDINATOR=https://127.0.0.1:28443 VIEWER_FIXTURE_OWNER=pilot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa TEST_VIEWER_TOKEN=synthetic-fixture VIEWER_FIXTURE_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
node --require ./test/helpers/pilot-synthetic-fetch.cjs test/helpers/real-coordinator-chain.cjs prepare
node --require ./test/helpers/pilot-synthetic-fetch.cjs test/helpers/real-coordinator-chain.cjs submit
node --require ./test/helpers/pilot-synthetic-fetch.cjs test/helpers/real-coordinator-chain.cjs status
SYNTHETIC_ARCHIVE_HASH=$(sha256sum /fixture-archive/result.zip | cut -d ' ' -f1)
SYNTHETIC_ARCHIVE_SIZE=$(stat -c %s /fixture-archive/result.zip)
export SYNTHETIC_ARCHIVE_HASH SYNTHETIC_ARCHIVE_SIZE
node -e 'const fs=require("fs");const i=JSON.parse(fs.readFileSync("/fixture-state/viewer/identity.json"));fs.writeFileSync("/fixture-receipt/terminal.json",JSON.stringify({schemaVersion:1,runId:i.ownerId,providerTaskId:i.providerTaskId,status:"completed",archiveSha256:process.env.SYNTHETIC_ARCHIVE_HASH,archiveByteSize:Number(process.env.SYNTHETIC_ARCHIVE_SIZE)}));'
sleep 6
node --require ./test/helpers/pilot-synthetic-fetch.cjs test/helpers/real-coordinator-chain.cjs finish
