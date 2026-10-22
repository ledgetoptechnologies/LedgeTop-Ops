import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = readFileSync(new URL("../truenas/thumbnail-generation/thumbnail-queue-worker.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
function shellFunction(name) {
  const match = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `${name} is present`);
  return match[0];
}

test("actual claim shell reports only allowlisted diagnostics and never replays a failed request", t => {
  if (process.platform === "win32" && !existsSync(bash)) return t.skip("Git Bash unavailable");
  const id = "e91754ec-4810-45f4-a2c5-fb47d92d5ed5";
  for (const [body, expected] of [
    [{ error: "claim_database_unavailable", correlationId: id, detail: "SECRET-private-source" }, `category=claim_database_unavailable request=${id}`],
    [{ error: "claim_internal_error", correlationId: id }, `category=claim_internal_error request=${id}`],
    [{ error: "SECRET-private-source", correlationId: "SECRET-invalid\ninjected" }, "category=unclassified request=unavailable"],
  ]) {
    const result = spawnSync(bash, ["-s"], { encoding: "utf8", input: `set -eu
CURRENT_JOB_DIR=$(mktemp -d)
trap 'rm -rf -- "$CURRENT_JOB_DIR"' EXIT
LTDSTHUMB_API_BASE=https://incoming.example.test
${shellFunction("json_string")}
${shellFunction("log_claim_rejection")}
${shellFunction("claim_once")}
log() { printf '%s\\n' "$*" >&2; }
calls=0
_raw_ops_json() {
  calls=$((calls+1))
  printf '%s' ${quoted(JSON.stringify(body))} > "$4"
  printf '%s' 503 > "$5"
}
rc=0
claim_once || rc=$?
printf 'calls=%s rc=%s\\n' "$calls" "$rc"
` });
    if (result.error?.code === "ENOENT") return t.skip("Bash unavailable");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "calls=1 rc=20");
    assert.match(result.stderr, /claim rejected with HTTP 503/);
    assert.ok(result.stderr.includes(expected), result.stderr);
    assert.ok(!result.stderr.includes("SECRET"));
  }
});

test("claim and transfer errors use a bounded thirty-second polling delay", () => {
  assert.match(script, /CLAIM_FAILURE_DELAY_SECONDS=30/);
  assert.match(script, /elif \(\( rc == 20 \)\); then[\s\S]*?sleep "\$CLAIM_FAILURE_DELAY_SECONDS" &/);
});
