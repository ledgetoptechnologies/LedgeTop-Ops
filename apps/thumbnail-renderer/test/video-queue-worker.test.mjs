import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptUrl = new URL("../bin/truenas-video-queue-worker.sh", import.meta.url);
const script = await readFile(scriptUrl, "utf8");

test("video queue worker has valid Bash syntax", (t) => {
  if (process.platform === "win32") {
    t.skip("the Windows test host does not provide a native Bash runtime");
    return;
  }
  const result = spawnSync("bash", ["-n", scriptUrl.pathname], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    t.skip("bash is unavailable on this platform");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("video queue worker is pinned to the private Operations origin", () => {
  assert.match(script, /readonly EXPECTED_API_BASE="https:\/\/ops\.ledgetopdroneservices\.com\/api\/internal\/thumbnail-renderer\/v1"/);
  assert.doesNotMatch(script, /incoming\.ledgetopdroneservices\.com/);
  assert.match(script, /LTDSTHUMB_API_BASE" == "\$EXPECTED_API_BASE"/);
  assert.match(script, /CF-Access-Client-Id: \$CF_ACCESS_CLIENT_ID/);
  assert.match(script, /CF-Access-Client-Secret: \$CF_ACCESS_CLIENT_SECRET/);
  assert.match(script, /Authorization: Bearer \$LTDSTHUMB_API_TOKEN/);
});

test("video queue worker can claim only videos and enforces exact byte limits", () => {
  assert.match(script, /\/claim\?includeKind=video/);
  assert.doesNotMatch(script, /excludeKind=video/);
  assert.match(script, /readonly MAX_SOURCE_BYTES=10737418240\b/);
  assert.match(script, /readonly MAX_OUTPUT_BYTES=131072\b/);
  assert.match(script, /"\$media_kind" != "video"/);
  assert.match(script, /source_url_unavailable/);
  assert.match(script, /json_string "\$LAST_HTTP_BODY" r2SourceUrl/);
  assert.match(script, /download_url=\$\(resolve_ops_url "\$source_url"/);
  assert.match(script, /_raw_source_download/);
  assert.match(script, /--disable --silent --show-error --fail --max-redirs 0/);
  assert.match(script, /--proto '=https' --proto-redir '=https'/);
  assert.match(script, /--header "CF-Access-Client-Secret: \$CF_ACCESS_CLIENT_SECRET"/);
  assert.match(script, /downloaded_size.*!= "\$source_size"/s);
});

test("every attempt callback serializes the opaque lease id safely", () => {
  assert.match(script, /json\.dumps\(\{"sourceKey":sys\.argv\[1\],"leaseId":sys\.argv\[2\]\}/);
  assert.match(script, /json\.dumps\(\{"sourceKey":sys\.argv\[1\],"leaseId":sys\.argv\[2\],"errorCode"/);
  assert.match(script, /json\.dumps\(\{"leaseId":sys\.argv\[1\],"thumbnailKey"/);
  assert.match(script, /json_heartbeat_payload "\$source_key" "\$lease_id"/);
  assert.match(script, /json_fail_payload "\$source_key" "\$lease_id"/);
  assert.match(script, /json_complete_payload "\$lease_id" "\$thumbnail_key"/);
  assert.doesNotMatch(script, /\{\\"sourceKey\\":\\"\$source_key/);
});

test("heartbeat begins immediately, repeats every 60 seconds, and guards work", () => {
  assert.match(script, /readonly HEARTBEAT_SECONDS=60\b/);
  const start = script.slice(script.indexOf("start_heartbeat()"), script.indexOf("fail_job()"));
  assert.ok(start.indexOf("heartbeat_once") < start.indexOf("while sleep \"$HEARTBEAT_SECONDS\""));
  assert.match(script, /run_guarded _raw_ops_upload/);
  assert.match(script, /run_guarded _raw_source_download/);
  assert.match(script, /run_guarded timeout --signal=TERM/);
  assert.match(script, /lease_is_live \|\| return 75/);
  assert.match(script, /mark_stale\n\s+log "claim abandoned: heartbeat was not accepted"/);
});

test("upload is a bounded WebP and process cleanup is deterministic", () => {
  assert.match(script, /--header "Content-Type: image\/webp"/);
  assert.match(script, /--header "Content-Length: \$input_size"/);
  assert.match(script, /--upload-file "\$input_file"/);
  assert.match(script, /mktemp -d "\$LTDSTHUMB_SCRATCH_DIR\/video-job\.XXXXXX"/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /stop_active_command\n\s+stop_heartbeat/);
  assert.match(script, /-frames:v 1/);
  assert.match(script, /-map_metadata -1 -map_chapters -1/);
  assert.match(script, /ffmpeg -hide_banner -loglevel quiet/);
  assert.match(script, /-protocol_whitelist file,pipe -i "\$source_file"/);
  assert.doesNotMatch(script, /ffmpeg[^\n]*https?:/);
  assert.doesNotMatch(script, /ffmpeg[^\n]*-loglevel (?:error|warning|info|verbose|debug|trace)/);
});
