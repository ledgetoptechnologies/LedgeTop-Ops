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

test("queue worker uses the shared NAS link token and sends the bearer only while it is set", () => {
  assert.doesNotMatch(script, /CF_ACCESS_CLIENT_ID:=/, "no per-field alias that could mix two identities");
  assert.match(script, /\nresolve_access_pair\n/);
  assert.match(script, /LTDSTHUMB_API_TOKEN="\$LTDSTHUMB_API_TOKEN" CF_ACCESS_CLIENT_ID="\$CF_ACCESS_CLIENT_ID" CF_ACCESS_CLIENT_SECRET="\$CF_ACCESS_CLIENT_SECRET" \\\n  python3 -c '\nimport http\.server/,
    "the stream proxy receives the resolved pair explicitly");
  assert.match(script, /if \[\[ -z "\$CF_ACCESS_CLIENT_ID" \|\| -n "\$LTDSTHUMB_API_TOKEN" \]\]; then\n  valid_secret "\$LTDSTHUMB_API_TOKEN" \|\| die/);
  assert.equal((script.match(/  if \[\[ -n "\$LTDSTHUMB_API_TOKEN" \]\]; then\n    args\+=\(--header "Authorization: Bearer \$LTDSTHUMB_API_TOKEN"\)\n  fi\n/g) ?? []).length, 3);
  assert.doesNotMatch(script, /^    --header "Authorization: Bearer/m, "no unconditional bearer header");
  assert.match(script, /raise SystemExit\("missing renderer API token or NAS link token"\)/);
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

// Behaviour of the real resolve_access_pair (extracted from the script) under bash. Synthetic values only.
const functionOf = name => {
  const start = script.indexOf(`${name}() {`);
  assert.ok(start >= 0, name);
  return script.slice(start, script.indexOf("\n}\n", start) + 3);
};
function runResolver(env, after = 'printf "%s|%s" "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET"') {
  const body = ["log() { printf '%s\\n' \"$*\" >&2; }", "die() { log \"fatal: $*\"; exit 2; }",
    functionOf("valid_secret"), functionOf("resolve_access_pair"), "resolve_access_pair", after].join("\n");
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CF_ACCESS_|NAS_LINK_)/.test(k)));
  return spawnSync("bash", ["-c", body], { encoding: "utf8", env: { ...clean, ...env } });
}
const bashAvailable = () => process.platform !== "win32" && !spawnSync("bash", ["-c", "true"]).error;

test("access pair: one complete pair from one source; partial or conflicting configs stop", (t) => {
  if (!bashAvailable()) { t.skip("bash is unavailable on this platform"); return; }
  const LINK = { NAS_LINK_CLIENT_ID: "link-id.access", NAS_LINK_CLIENT_SECRET: "link-secret-0000000000000000000000" };
  const OLD = { CF_ACCESS_CLIENT_ID: "old-id.access", CF_ACCESS_CLIENT_SECRET: "old-secret-00000000000000000000000" };
  const ok = (env, expected) => { const r = runResolver(env); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, expected); };
  const stops = (env, message) => {
    const r = runResolver(env);
    assert.equal(r.status, 2, `${message}: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(message));
    for (const value of [...Object.values(LINK), ...Object.values(OLD)]) assert.ok(!r.stderr.includes(value), "no value in the message");
  };
  ok(LINK, "link-id.access|link-secret-0000000000000000000000");
  ok(OLD, "old-id.access|old-secret-00000000000000000000000");
  ok({ ...OLD, NAS_LINK_CLIENT_ID: OLD.CF_ACCESS_CLIENT_ID, NAS_LINK_CLIENT_SECRET: OLD.CF_ACCESS_CLIENT_SECRET }, "old-id.access|old-secret-00000000000000000000000");
  ok({}, "|");
  stops({ ...OLD, ...LINK }, "differ from the shared NAS link token");
  stops({ CF_ACCESS_CLIENT_ID: OLD.CF_ACCESS_CLIENT_ID, ...LINK }, "must be set together");
  stops({ CF_ACCESS_CLIENT_SECRET: OLD.CF_ACCESS_CLIENT_SECRET, ...LINK }, "must be set together");
  stops({ NAS_LINK_CLIENT_ID: LINK.NAS_LINK_CLIENT_ID }, "NAS_LINK_CLIENT_ID and NAS_LINK_CLIENT_SECRET must be set together");
  stops({ ...OLD, NAS_LINK_CLIENT_ID: LINK.NAS_LINK_CLIENT_ID }, "differ from the shared NAS link token");
});

test("access pair: a link-only pair reaches a child process only through the explicit hand-off", (t) => {
  if (!bashAvailable()) { t.skip("bash is unavailable on this platform"); return; }
  const LINK = { NAS_LINK_CLIENT_ID: "link-id.access", NAS_LINK_CLIENT_SECRET: "link-secret-0000000000000000000000" };
  const child = `bash -c 'printf "%s|%s" "\${CF_ACCESS_CLIENT_ID:-}" "\${CF_ACCESS_CLIENT_SECRET:-}"'`;
  const implicit = runResolver(LINK, child);
  assert.equal(implicit.stdout, "|", "an alias-filled pair is not exported on its own");
  const explicit = runResolver(LINK, `CF_ACCESS_CLIENT_ID="$CF_ACCESS_CLIENT_ID" CF_ACCESS_CLIENT_SECRET="$CF_ACCESS_CLIENT_SECRET" ${child}`);
  assert.equal(explicit.stdout, "link-id.access|link-secret-0000000000000000000000", "the script's hand-off form passes the pair");
});
