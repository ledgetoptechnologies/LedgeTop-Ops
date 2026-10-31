#!/bin/sh
# Synthetic provider only. Caller must supply a network-none disposable container,
# empty fixture mounts, an extracted source copy, and a read-only fixture archive.
set -eu
test "${LTDS_PILOT_REAL_FIXTURE_TEST:-}" = 1
test "$(pwd -P)" = /scratch
test -z "$(ls -A /fixture-state)"
test -z "$(ls -A /fixture-input)"
test -z "$(ls -A /fixture-receipt)"
test -f /fixture-archive/result.zip
unset LTDS_PILOT_SYNTHETIC_TEST
export VIEWER_FIXTURE_ROOT=/fixture-state/viewer VIEWER_FIXTURE_PHOTOS=/fixture-input VIEWER_FIXTURE_COORDINATOR=https://127.0.0.1:28443 VIEWER_FIXTURE_OWNER=pilot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa TEST_VIEWER_TOKEN=synthetic-fixture VIEWER_FIXTURE_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= VIEWER_PILOT_REAL_ENABLED=1 VIEWER_PILOT_PHASE_NONCE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf %s "$VIEWER_FIXTURE_OWNER" > /fixture-state/.viewer-pilot-owner
chmod 600 /fixture-state/.viewer-pilot-owner
i=0
while [ "$i" -lt 40 ]; do printf 'synthetic-photo-%s' "$i" > "/fixture-input/photo-$i.jpg"; i=$((i+1)); done
run_phase(){
 phase=$1
 if [ "$phase" != prepare ]; then
  printf '{"schemaVersion":1,"ownerId":"%s","phase":"%s","nonce":"%s"}' "$VIEWER_FIXTURE_OWNER" "$phase" "$VIEWER_PILOT_PHASE_NONCE" > /fixture-state/.viewer-pilot-phase
  chmod 600 /fixture-state/.viewer-pilot-phase
 fi
 node --require ./test/helpers/pilot-synthetic-fetch.cjs test/helpers/real-coordinator-chain.cjs "$phase"
 if [ "$phase" != prepare ]; then rm /fixture-state/.viewer-pilot-phase; fi
}
run_phase prepare
run_phase submit
run_phase status
SYNTHETIC_ARCHIVE_HASH=$(sha256sum /fixture-archive/result.zip | cut -d ' ' -f1)
SYNTHETIC_ARCHIVE_SIZE=$(stat -c %s /fixture-archive/result.zip)
export SYNTHETIC_ARCHIVE_HASH SYNTHETIC_ARCHIVE_SIZE
node -e 'const fs=require("fs");const i=JSON.parse(fs.readFileSync("/fixture-state/viewer/identity.json"));fs.writeFileSync("/fixture-receipt/terminal.json",JSON.stringify({schemaVersion:1,runId:i.ownerId,providerTaskId:i.providerTaskId,status:"completed",archiveSha256:process.env.SYNTHETIC_ARCHIVE_HASH,archiveByteSize:Number(process.env.SYNTHETIC_ARCHIVE_SIZE)}));'
sleep 6
run_phase finish
