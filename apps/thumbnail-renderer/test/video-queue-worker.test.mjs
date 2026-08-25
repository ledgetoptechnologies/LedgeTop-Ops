import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptUrl = new URL("../truenas/thumbnail-generation/thumbnail-queue-worker.sh", import.meta.url);
const script = (await readFile(scriptUrl, "utf8")).replaceAll("\r\n", "\n");

test("unified queue worker has valid Bash syntax", (t) => {
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

test("unified queue worker is pinned to approved renderer origins", () => {
  assert.match(script, /readonly EXPECTED_API_BASE="https:\/\/incoming\.ledgetopdroneservices\.com\/api\/internal\/thumbnail-renderer\/v1"/);
  assert.match(script, /readonly ACCESS_API_BASE="https:\/\/ops\.ledgetopdroneservices\.com\/api\/internal\/thumbnail-renderer\/v1"/);
  assert.match(script, /LTDSTHUMB_API_BASE" == "\$EXPECTED_API_BASE"/);
  assert.match(script, /LTDSTHUMB_API_BASE" == "\$ACCESS_API_BASE"/);
  assert.match(script, /the Operations renderer endpoint requires CF_ACCESS_CLIENT_ID/);
  assert.match(script, /base = urlsplit\(sys\.argv\[1\]\)/);
  assert.match(script, /parsed\.hostname != base\.hostname/);
  assert.match(script, /\/api\/internal\/thumbnail-renderer\/v1\/thumbnail\//);
  assert.match(script, /CF-Access-Client-Id: \$CF_ACCESS_CLIENT_ID/);
  assert.match(script, /CF-Access-Client-Secret: \$CF_ACCESS_CLIENT_SECRET/);
  assert.match(script, /if \[\[ -n "\$CF_ACCESS_CLIENT_ID" \]\]; then/);
  assert.doesNotMatch(script, /CF_ACCESS_CLIENT_ID is required/);
  assert.match(script, /Authorization: Bearer \$LTDSTHUMB_API_TOKEN/);
});

test("unified queue worker claims all supported media and range-streams videos", () => {
  assert.match(script, /\/claim\?includeKind=all/);
  assert.doesNotMatch(script, /excludeKind=video/);
  assert.match(script, /readonly MAX_IMAGE_BYTES=536870912\b/);
  assert.match(script, /readonly MAX_IMAGE_PIXELS=512000000\b/);
  assert.match(script, /readonly LARGE_IMAGE_PIXELS=128000000\b/);
  assert.match(script, /readonly MAX_PDF_BYTES=268435456\b/);
  assert.match(script, /readonly MAX_VIDEO_BYTES=10737418240\b/);
  assert.match(script, /readonly MAX_OUTPUT_BYTES=131072\b/);
  assert.match(script, /readonly MAX_STREAM_BYTES=536870912\b/);
  assert.match(script, /readonly MAX_UPSTREAM_RANGE_BYTES=8388608\b/);
  assert.match(script, /current_start \+ max_upstream_range_bytes - 1/);
  assert.match(script, /next_headers\["Range"\] = f"bytes=\{current_start\}-\{current_end\}"/);
  assert.match(script, /image\) maximum_source_bytes=\$MAX_IMAGE_BYTES/);
  assert.match(script, /pdf\) maximum_source_bytes=\$MAX_PDF_BYTES/);
  assert.match(script, /video\) maximum_source_bytes=\$MAX_VIDEO_BYTES/);
  assert.match(script, /validate_presigned_url "\$presigned_url"/);
  assert.match(script, /source_url=\$\(resolve_ops_source_url "\$source_url"/);
  assert.match(script, /stream_auth_mode="ops"/);
  assert.match(script, /base_headers\["Authorization"\] = f"Bearer \{token\}"/);
  assert.match(script, /base_headers\["CF-Access-Client-Id"\] = access_id/);
  assert.ok(script.includes('\\.r2\\.cloudflarestorage\\.com'));
  assert.match(script, /printf '%s' "\$source_url" >"\$source_url_file"/);
  assert.doesNotMatch(script, /REMOTE_SOURCE_URL/);
  assert.match(script, /os\.unlink\(source_url_file\)/);
  assert.match(script, /bytes_forwarded \+ len\(chunk\) > max_stream_bytes/);
  assert.match(script, /Server\(\("127\.0\.0\.1", 0\), Handler\)/);
  assert.match(script, /STREAM_PROXY_URL="http:\/\/127\.0\.0\.1:\$\{port\}\/source"/);
  assert.match(script, /ffprobe -v error -protocol_whitelist http,tcp/);
  assert.match(script, /input_options=\(-f "\$demuxer"\)/);
  assert.match(script, /sourceContentType/);
  assert.match(script, /video\/mp4\|video\/quicktime\|video\/3gpp\) demuxer="mov"/);
  assert.match(script, /application\/octet-stream\|""\)/);
  assert.match(script, /unsupported_video_container/);
  assert.match(script, /-enable_drefs 0 -use_absolute_path 0/);
  assert.match(script, /-ss "\$VIDEO_SEEK" -protocol_whitelist http,tcp "\$\{input_options\[@\]\}" -i "\$stream_url"/);
  assert.match(script, /render_deadline=.*LTDSTHUMB_RENDER_TIMEOUT_SECONDS/);
  assert.match(script, /download_source "\$source_url" "\$source_file" "\$source_size" "\$maximum_source_bytes"/);
  assert.match(script, /pixel_class=\$\(image_pixel_class "\$source_file"/);
  assert.match(script, /acquire_large_image_slot/);
  assert.match(script, /flock -n 8/);
  assert.match(script, /release_large_image_slot/);
  assert.match(script, /--max-filesize "\$maximum_bytes"/);
  assert.match(script, /node \/app\/src\/queue-render\.mjs "\$media_kind"/);
  assert.doesNotMatch(script, /source\.video/);
  assert.match(script, /LTDSTHUMB_SCRATCH_DIR must be a tmpfs RAM mount/);
  assert.match(script, /duration >= 5/);
  assert.match(script, /duration \/ 2/);
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
  assert.ok(start.indexOf("heartbeat_once") < start.indexOf("while true"));
  assert.match(start, /printf '%s' "\$sleep_pid" >"\$HEARTBEAT_SLEEP_PID_FILE"/);
  assert.match(script, /kill -TERM "\$sleep_pid"/);
  assert.match(script, /run_guarded _raw_ops_upload/);
  assert.match(script, /run_guarded timeout[^\n]*\n\s+ffprobe/s);
  assert.match(script, /run_guarded timeout --signal=TERM/);
  assert.match(script, /lease_is_live \|\| return 75/);
  assert.match(script, /mark_stale\n\s+log "claim abandoned: heartbeat was not accepted"/);
});

test("upload is a bounded WebP and process cleanup is deterministic", () => {
  assert.match(script, /--header "Content-Type: image\/webp"/);
  assert.match(script, /--header "Content-Length: \$input_size"/);
  assert.match(script, /--upload-file "\$input_file"/);
  assert.match(script, /mktemp -d "\$LTDSTHUMB_SCRATCH_DIR\/thumbnail-job\.XXXXXX"/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /stop_active_command\n\s+stop_stream_proxy\n\s+stop_heartbeat/);
  assert.match(script, /-frames:v 1/);
  assert.match(script, /-map_metadata -1 -map_chapters -1/);
  assert.match(script, /ffmpeg -hide_banner -loglevel quiet/);
  assert.match(script, /-protocol_whitelist http,tcp "\$\{input_options\[@\]\}" -i "\$stream_url"/);
  assert.doesNotMatch(script, /ffmpeg[^\n]*REMOTE_SOURCE_URL/);
  assert.doesNotMatch(script, /ffmpeg[^\n]*r2PresignedUrl/);
  assert.doesNotMatch(script, /ffmpeg[^\n]*-loglevel (?:error|warning|info|verbose|debug|trace)/);
});
