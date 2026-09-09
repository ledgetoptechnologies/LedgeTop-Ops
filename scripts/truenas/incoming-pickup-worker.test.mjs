import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = await readFile(new URL("./incoming-pickup-worker.sh", import.meta.url), "utf8");
const worker = fileURLToPath(new URL("./incoming-pickup-worker.sh", import.meta.url)).replaceAll("\\", "/");
// These fixtures exercise the real TrueNAS shell contract (POSIX directories,
// GNU coreutils, and Python 3). They run in the Linux container CI image; the
// Windows desktop host still runs the static invariant checks below.
const canRunWorkerFixtures = process.platform !== "win32";

const requestId = "request-0001";
const uploadId = "upload-0001";
const objectKey = `quarantine/${requestId}/${uploadId}/object`;
const claimToken = "11111111-1111-4111-8111-111111111111";

async function executable(path, contents) {
  await writeFile(path, contents, "utf8");
  await chmod(path, 0o755);
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "incoming-pickup-test-"));
  const bin = join(root, "bin");
  const destination = join(root, "incoming");
  const staging = join(destination, ".incoming-staging");
  const state = join(destination, ".incoming-state");
  await mkdir(bin, { recursive: true });
  const metadata = options.metadata ?? { requestid: requestId, originalname: "photo.jpg" };
  const list = options.list ?? [{ Key: objectKey, Size: 4 }];
  await executable(join(bin, "aws"), `#!/usr/bin/env bash
set -eu
case " $* " in
  *" list-objects-v2 "*) printf '%s\\n' '${JSON.stringify({ Contents: list })}' ;;
  *" head-object "*) ${options.headMissing ? "exit 1" : `printf '%s\\n' '${JSON.stringify({ ContentLength: 4, ETag: '"abcd"', Metadata: metadata })}'`} ;;
  *" get-object "*) ${options.getLog ? `printf 'downloaded\\n' >> '${options.getLog.replaceAll("'", "'\\''")}'` : ":"}; printf 'data' > "${"${@: -1}"}" ;;
  *" delete-object "*) ${options.deleteLog ? `printf 'deleted\\n' >> '${options.deleteLog.replaceAll("'", "'\\''")}'` : ":"} ;;
  *) exit 1 ;;
esac
`);
  await executable(join(bin, "curl"), `#!/usr/bin/env bash
set -eu
config="$2"
output=$(sed -n 's/^output = "//p' "$config" | sed 's/"$//')
${options.apiLog ? `cat "$config" >> '${options.apiLog.replaceAll("'", "'\\''")}'` : ":"}
if grep -q 'request = "GET"' "$config"; then
  ${options.pendingEmptyAfter ? `if grep -q 'verification-pending' "$config" && [ -e '${options.pendingEmptyAfter.replaceAll("'", "'\\''")}' ]; then printf '%s' '{"uploads":[],"nextCursor":null}' > "$output"; else` : ":"}
  ${options.verifiedBodyByCursor ? `if grep -q 'cursor=page2' "$config"; then printf '%s' '${options.verifiedBodyByCursor.page2.replaceAll("'", "'\\''")}' > "$output"; else printf '%s' '${options.verifiedBodyByCursor.first.replaceAll("'", "'\\''")}' > "$output"; fi` : (options.apiBody ?? options.pendingBody ?? options.verifiedBody) ? `printf '%s' '${(options.apiBody ?? options.pendingBody ?? options.verifiedBody).replaceAll("'", "'\\''")}' > "$output"` : ":"}
  ${options.pendingEmptyAfter ? "fi" : ":"}
fi
${options.failInventoryOnce ? `if grep -q 'archive-inventory' "$config" && [ ! -e '${options.failInventoryOnce.replaceAll("'", "'\\''")}' ]; then : > '${options.failInventoryOnce.replaceAll("'", "'\\''")}'; exit 7; fi` : ":"}
${options.inventoryStatus ? `if grep -q 'archive-inventory' "$config"; then printf '${options.inventoryStatus}'; exit 0; fi` : ":"}
printf '200'
`);
  await executable(join(bin, "flock"), `#!/usr/bin/env bash
${options.flockLog ? `printf '%s\\n' "$*" >> '${options.flockLog.replaceAll("'", "'\\''")}'` : ":"}
${options.failFlock ? "exit 1" : "exit 0"}
`);
  await executable(join(bin, "clamscan"), `#!/usr/bin/env bash
${options.raceDestination ? `mkdir -p '${options.raceDestination.replaceAll("'", "'\\''")}'` : ":"}
exit 0
`);
  const env = {
    ...process.env,
    // Keep fake worker dependencies ahead of the system tools on both the
    // Windows static-test host and the Linux TrueNAS-style fixture runtime.
    PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    INCOMING_PICKUP_R2_BUCKET: "incoming-private",
    INCOMING_PICKUP_R2_ENDPOINT: "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
    AWS_ACCESS_KEY_ID: "pickup-key",
    AWS_SECRET_ACCESS_KEY: "pickup-secret",
    INCOMING_PICKUP_SECRET: "pickup-receipt-secret",
    INCOMING_PICKUP_DESTINATION_DIR: destination,
    INCOMING_PICKUP_STAGING_DIR: staging,
    INCOMING_PICKUP_STATE_DIR: state,
    INCOMING_PICKUP_API_BASE: "https://incoming.ledgetopdroneservices.com/api/internal/uploads",
    INCOMING_PICKUP_MAX_JOBS: "1",
  };
  return { root, bin, destination, staging, state, env };
}

function runWorker(env, mode = "--once", trace = false) {
  const result = spawnSync("bash", trace ? ["-x", worker, mode] : [worker, mode], { env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("incoming pickup worker retains its safe quarantine-to-acceptance order", () => {
  const position = (needle) => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, `missing worker invariant: ${needle}`);
    return index;
  };
  position("flock -n 9");
  assert.match(source, /quarantine\/\(\[A-Za-z0-9_-\]\{8,200\}\)\/\(\[A-Za-z0-9_-\]\{8,200\}\)\/object/);
  position("clamscan --no-summary --infected");
  position('write_receipt "$CURRENT_STAGE/receipt.json" "promoted"');
  position('same_identity "$after_scan" "$object_etag" "$object_bytes"');
  position('delete_exact_object "$key"');
  position('post_acceptance "$upload_id" "$digest"');
  position('post_pickup_status "$upload_id" scanning');
  position('post_pickup_status "$upload_id" retry');
  position('if ! retry_due "$upload_id" "$identity"; then');
  position('key="quarantine/$request_id/$upload_id/object"');
  position('final_dir="$final_parent/$upload_id"');
  position('stage_file="$CURRENT_STAGE/payload/$original_name"');
  position('valid_payload_name "$original_name"');
  position("INCOMING_PICKUP_MAX_SOURCE_BYTES");
  position("INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS");
  position("INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS");
  position("canonical_private_dir()");
  position('atomic_promote_dir "$CURRENT_STAGE" "$final_dir"');
  assert.match(source, /renameat2/);
  assert.match(source, /RENAME_NOREPLACE = 1/);
  assert.match(source, /platform\.machine\(\)\.lower\(\)/);
  assert.match(source, /"x86_64": 316, "amd64": 316/);
  assert.match(source, /"aarch64": 276, "arm64": 276/);
  assert.match(source, /"riscv64": 276/);
  assert.match(source, /getattr\(libc, "syscall", None\)/);
  assert.match(source, /len\(name\.encode\("utf-8"\)\) <= 255/);
  assert.match(source, /len\(original_name\.encode\("utf-8"\)\) > 255/);
  assert.doesNotMatch(source, /mv -T -- "\$CURRENT_STAGE" "\$final_dir"/);

  const scan = position("clamscan --no-summary --infected");
  const durablePromotion = position('write_receipt "$CURRENT_STAGE/receipt.json" "promoted"');
  const noReplacePromotion = position('atomic_promote_dir "$CURRENT_STAGE" "$final_dir"');
  const directoryDurability = source.indexOf('durable_promotion_parent "$final_dir"', noReplacePromotion);
  const deletion = position('delete_exact_object "$key"');
  const receipt = position('post_acceptance "$upload_id" "$digest"');
  assert.ok(scan < durablePromotion, "scan must precede local promotion");
  assert.ok(durablePromotion < deletion, "local promotion must precede remote deletion");
  assert.ok(noReplacePromotion < directoryDurability && directoryDurability < deletion,
    "request parent and destination root must be fsynced after rename and before deleting R2");
  assert.ok(deletion < receipt, "remote deletion must precede the acceptance receipt");
});

test("incoming pickup worker pages past deferred entries and caps actual transfer attempts", () => {
  assert.match(source, /readonly LIST_PAGE_SIZE=1000/);
  assert.match(source, /--continuation-token/);
  assert.match(source, /list_candidates_page "\$continuation"/);
  assert.ok(source.includes("while (( attempts < INCOMING_PICKUP_MAX_JOBS )); do"));
  assert.match(source, /PICKUP_ATTEMPTED=1/);
  assert.ok(source.includes("(( PICKUP_ATTEMPTED == 1 )) && (( attempts += 1 ))"));
  assert.match(source, /source_size_exceeded/);

  const list = source.indexOf("list_candidates_page() {");
  const maxKeyPage = source.indexOf('--max-keys "$LIST_PAGE_SIZE"', list);
  const transfer = source.indexOf("PICKUP_ATTEMPTED=1");
  const download = source.indexOf("s3api get-object", transfer);
  assert.ok(maxKeyPage > list, "listing must use a page size independent of job attempt cap");
  assert.ok(transfer < download, "an actual attempt starts before the source transfer");
});

test("oversize objects become durable deferred retries without a source download", () => {
  const bound = source.indexOf('configured source-byte bound was exceeded');
  const scanClaim = source.indexOf('post_pickup_status "$upload_id" scanning', bound);
  const deferred = source.indexOf('source_size_exceeded', bound);
  const transfer = source.indexOf("PICKUP_ATTEMPTED=1", bound);
  assert.ok(bound >= 0 && scanClaim > bound && deferred > scanClaim, "oversize source must receive a bounded retry state");
  assert.ok(transfer > deferred, "oversize deferral must happen before any transfer can start");
  assert.match(source, /marker\["errorCode"\] == "source_size_exceeded"/);
  assert.match(source, /identity\["bytes"\] <= int\(os\.environ\["INCOMING_PICKUP_MAX_SOURCE_BYTES"\]\)/);
  assert.match(source, /"payloadName": payload_name/);
  assert.match(source, /-mindepth 2 -maxdepth 3/);
});

test("incoming pickup binds lifecycle callbacks to a persisted, renewable claim", () => {
  assert.match(source, /claimToken/);
  assert.match(source, /new_claim_token\(\)/);
  assert.match(source, /write_claim_marker/);
  assert.match(source, /claim_token_for_identity/);
  assert.match(source, /state\":\"heartbeat/);
  assert.match(source, /trap stop_heartbeat_sleep TERM INT/);
  assert.match(source, /sleep 300 &/);
  assert.match(source, /wait "\$heartbeat_sleep_pid" \|\| exit 0/);
  assert.match(source, /post_acceptance "\$upload_id" "\$digest" "\$claim_token"/);
  assert.match(source, /rm -f -- "\$\(claim_marker_path "\$upload_id"\)"/);

  const claim = source.indexOf('post_pickup_status "$upload_id" scanning "$claim_token"');
  const persist = source.indexOf('write_claim_marker "$upload_id" "$object_etag" "$object_bytes" "$claim_token"', claim);
  const transfer = source.indexOf("PICKUP_ATTEMPTED=1", claim);
  assert.ok(claim >= 0 && persist > claim && transfer > persist, "persist the claim before reading source bytes");
});

test("incoming pickup worker cannot extract or render quarantined content", () => {
  assert.doesNotMatch(source, /(^|[^\w])(unzip|7z|ffmpeg|vips|pdftocairo)([^\w]|$)/m);
});

test("incoming pickup worker constrains its endpoints and logs", () => {
  assert.match(source, /incoming\\\.\(ledgetopdroneservices\|ledgetoptechnologies\)/);
  assert.match(source, /valid_r2_endpoint/);
  assert.match(source, /canonical_private_dir/);
  assert.match(source, /outside a quarantine segment/);
  assert.match(source, /cloudflarestorage/);
  assert.ok(source.includes("local paths, request IDs, content, credentials"));
  assert.match(source, /INCOMING_PICKUP_SECRET/);
  assert.doesNotMatch(source, /--header "Authorization: Bearer \$INCOMING_PICKUP_SECRET"/);
  assert.match(source, /curl --config "\$config_file"/);
  assert.match(source, /PICKUP_CALLBACK_PAYLOAD/);
  assert.match(source, /PICKUP_CLAIM_TOKEN/);
  assert.doesNotMatch(source, /\$payload" <<'PY'/);
});

test("incoming worker exposes bounded verification and verified-download modes", () => {
  assert.match(source, /--verify-only/);
  assert.match(source, /--pickup-only/);
  assert.match(source, /post_verification_status/);
  assert.match(source, /state":"verified/);
  const verify = source.indexOf('if [[ "$WORKER_MODE" == "verify" ]]');
  assert.ok(verify >= 0);
  assert.ok(source.indexOf('delete_exact_object "$key"', verify) > source.indexOf('if ! fsync_path "$stage_file"', verify),
    "verification branch must not delete the quarantine object");
  assert.match(source, /verification-candidates/);
});

test("verify-only proves bytes without promoting or deleting", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const deleteLog = join((await mkdtemp(join(tmpdir(), "incoming-verify-"))), "delete.log");
  const digest = createHash("sha256").update("data").digest("hex");
  const value = await fixture({ deleteLog, pendingBody: JSON.stringify({ uploads: [{ id: uploadId, requestId, objectKey, originalName: "photo.jpg", objectEtag: "abcd", objectBytes: 4 }], nextCursor: null }) });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = runWorker(value.env, "--verify-only");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  await assert.rejects(readFile(deleteLog));
  assert.equal(result.stderr.includes("source remains in quarantine"), true, `${result.stderr}\n${result.stdout}`);
  assert.equal(digest.length, 64);
});

test("verify-only persists failed inventory callbacks and replays without a second source read", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const root = await mkdtemp(join(tmpdir(), "incoming-inventory-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const getLog = join(root, "get.log"), failed = join(root, "failed.marker");
  const value = await fixture({ getLog, failInventoryOnce: failed, pendingEmptyAfter: failed, pendingBody: JSON.stringify({ uploads: [{ id: uploadId, requestId, objectKey, originalName: "photo.jpg", objectEtag: "abcd", objectBytes: 4 }], nextCursor: null }) });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  assert.equal(runWorker(value.env, "--verify-only").status, 0);
  assert.equal((await readdir(value.state)).some(name => name.startsWith(".inventory.")), true);
  const firstReads = (await readFile(getLog, "utf8")).trim().split("\n").length;
  value.env.INCOMING_PICKUP_MAX_JOBS = "1";
  const result = runWorker(value.env, "--verify-only");
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(getLog, "utf8")).trim().split("\n").length, firstReads);
  assert.equal((await readdir(value.state)).some(name => name.startsWith(".inventory.")), false);
});

test("inventory replay rotates past a repeatedly failing first receipt and skips non-ready state", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const root = await mkdtemp(join(tmpdir(), "incoming-inventory-fair-")), failed = join(root, "failed.marker");
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = await fixture({ failInventoryOnce: failed, pendingEmptyAfter: failed, pendingBody: JSON.stringify({ uploads: [{ id: uploadId, requestId, objectKey, originalName: "photo.jpg", objectEtag: "abcd", objectBytes: 4 }], nextCursor: null }) });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  runWorker(value.env, "--verify-only");
  const first = (await readdir(value.state)).find(name => name.startsWith(".inventory."));
  assert.ok(first);
  const nonReady = join(value.state, ".inventory.00000000"), second = join(value.state, ".inventory.zzzzzzzz");
  await mkdir(nonReady); await writeFile(join(nonReady, "upload-id"), uploadId);
  await mkdir(second); await writeFile(join(second, "upload-id"), "upload-0002"); await writeFile(join(second, "0000.archive-inventory-unavailable.json"), JSON.stringify({ claimToken, sha256: "a".repeat(64), objectEtag: "abcd", objectBytes: 4, inventoryId: "22222222-2222-4222-8222-222222222222", reason: "not_zip" })); await writeFile(join(second, "ready"), "");
  await writeFile(join(value.state, first, "retry-at"), "0\n");
  const result = runWorker(value.env, "--verify-only");
  assert.equal(result.status, 0, result.stderr);
  const remaining = await readdir(value.state);
  assert.equal(remaining.includes(".inventory.zzzzzzzz"), false, `rotated successor must be attempted: ${result.stderr} / ${remaining.join(",")}`);
  assert.equal(remaining.includes(".inventory.00000000"), true, "non-ready directory must not be published or consumed");
});

test("verify-only discards a stale inventory receipt acknowledged with 409", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const value = await fixture({ inventoryStatus: "409", pendingBody: JSON.stringify({ uploads: [{ id: uploadId, requestId, objectKey, originalName: "photo.jpg", objectEtag: "abcd", objectBytes: 4 }], nextCursor: null }) });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = runWorker(value.env, "--verify-only");
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readdir(value.state)).some(name => name.startsWith(".inventory.")), false);
});

test("verify-only never recovers or accepts a preexisting promoted receipt", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const root = await mkdtemp(join(tmpdir(), "incoming-verify-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deleteLog = join(root, "delete.log"), apiLog = join(root, "api.log");
  const value = await fixture({ deleteLog, apiLog, pendingBody: JSON.stringify({ uploads: [{ id: uploadId, requestId, objectKey }], nextCursor: null }) });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const finalDir = join(value.destination, requestId, uploadId), payload = Buffer.from("data");
  await mkdir(join(finalDir, "payload"), { recursive: true });
  await writeFile(join(finalDir, "payload", "photo.jpg"), payload);
  await writeFile(join(finalDir, "receipt.json"), JSON.stringify({ schemaVersion: 3, state: "promoted", uploadId, requestId, objectEtag: "abcd", objectBytes: 4, sha256: createHash("sha256").update(payload).digest("hex"), pickupClaimToken: claimToken, payloadName: "photo.jpg" }));
  const result = runWorker(value.env, "--verify-only");
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(deleteLog));
  const calls = await readFile(apiLog, "utf8").catch(() => "");
  assert.doesNotMatch(calls, /\/accepted/);
  assert.equal(JSON.parse(await readFile(join(finalDir, "receipt.json"), "utf8")).state, "promoted");
});

test("pickup-only rejects a verifier SHA mismatch without promotion or R2 deletion", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const root = await mkdtemp(join(tmpdir(), "incoming-pickup-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deleteLog = join(root, "delete.log");
  const value = await fixture({ deleteLog, verifiedBody: JSON.stringify({ uploads: [{ id: uploadId, requestId, objectKey, objectEtag: "abcd", objectBytes: 4, objectVersion: "r2-v1", sha256: "b".repeat(64) }], nextCursor: null }) });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = runWorker(value.env, "--pickup-only");
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(deleteLog), "a mismatched verifier hash must retain R2");
  await assert.rejects(readFile(join(value.destination, requestId, uploadId, "receipt.json")), "a mismatched verifier hash must not promote");
});

test("pickup-only promotes, deletes, and posts acceptance only after matching verifier SHA", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const root = await mkdtemp(join(tmpdir(), "incoming-pickup-matching-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deleteLog = join(root, "delete.log"), apiLog = join(root, "api.log"), getLog = join(root, "get.log");
  const digest = createHash("sha256").update("data").digest("hex");
  const value = await fixture({ deleteLog, apiLog, getLog, verifiedBody: JSON.stringify({ uploads: [{ id: uploadId, requestId, objectKey, objectEtag: "abcd", objectBytes: 4, objectVersion: "r2-v1", sha256: digest }], nextCursor: null }) });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = runWorker(value.env, "--pickup-only");
  assert.equal(result.status, 0, result.stderr);
  await readFile(getLog, "utf8").catch(async () => assert.fail(`${result.stderr}\n${await readFile(apiLog, "utf8").catch(() => "no API calls")}\n${await readFile(join(value.bin, "curl"), "utf8")}`));
  assert.equal(await readFile(deleteLog, "utf8"), "deleted\n");
  assert.match(await readFile(apiLog, "utf8"), /\/accepted/);
  assert.deepEqual(await readFile(join(value.destination, requestId, uploadId, "payload", "photo.jpg")), Buffer.from("data"));
});

test("pickup-only follows verified candidate pagination without skipping a second due upload", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const root = await mkdtemp(join(tmpdir(), "incoming-pickup-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secondUpload = "upload-0002", secondKey = `quarantine/${requestId}/${secondUpload}/object`;
  const digest = createHash("sha256").update("data").digest("hex"), deleteLog = join(root, "delete.log");
  const value = await fixture({ deleteLog, verifiedBodyByCursor: {
    first: JSON.stringify({ uploads: [{ id: uploadId, requestId, objectKey, objectEtag: "abcd", objectBytes: 4, objectVersion: "r2-v1", sha256: digest }], nextCursor: "page2" }),
    page2: JSON.stringify({ uploads: [{ id: secondUpload, requestId, objectKey: secondKey, objectEtag: "abcd", objectBytes: 4, objectVersion: "r2-v1", sha256: digest }], nextCursor: null }),
  } });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = runWorker({ ...value.env, INCOMING_PICKUP_MAX_JOBS: "2" }, "--pickup-only");
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(deleteLog, "utf8")).trim().split("\n").length, 2);
  assert.deepEqual(await readFile(join(value.destination, requestId, secondUpload, "payload", "photo.jpg")), Buffer.from("data"));
});

test("pickup-only uses a bounded lock wait and fails without listing when the lock cannot be acquired", async (t) => {
  if (!canRunWorkerFixtures) return t.skip("POSIX runtime required");
  const root = await mkdtemp(join(tmpdir(), "incoming-pickup-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const flockLog = join(root, "flock.log"), apiLog = join(root, "api.log");
  const value = await fixture({ flockLog, apiLog, failFlock: true, verifiedBody: JSON.stringify({ uploads: [], nextCursor: null }) });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = runWorker({ ...value.env, INCOMING_PICKUP_LOCK_WAIT_SECONDS: "0" }, "--pickup-only");
  assert.equal(result.status, 1, result.stderr);
  assert.match(await readFile(flockLog, "utf8"), /-w 0 9/);
  await assert.rejects(readFile(apiLog), "failed lock acquisition must not query candidates");
});

test("incoming pickup refuses hostile R2 basename metadata before downloading or promoting", async (t) => {
  if (!canRunWorkerFixtures) {
    t.skip("Windows host does not provide the TrueNAS POSIX runtime; Linux container CI exercises the worker fixture");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "incoming-pickup-hostile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const getLog = join(root, "download.log");
  const value = await fixture({ metadata: { requestid: requestId, originalname: "../escape" }, getLog });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const output = runWorker(value.env);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stderr, /worker finished/);
  await assert.rejects(readFile(join(value.destination, requestId, uploadId, "escape")));
  await assert.rejects(readFile(join(value.destination, requestId, uploadId, "receipt.json")));
  await assert.rejects(readFile(getLog), "hostile metadata must be rejected before any source read");
});

test("incoming pickup recovers a legacy v1 payload receipt without re-reading or renaming it", async (t) => {
  if (!canRunWorkerFixtures) {
    t.skip("Windows host does not provide the TrueNAS POSIX runtime; Linux container CI exercises the worker fixture");
    return;
  }
  const value = await fixture({ list: [], headMissing: true });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const legacyDir = join(value.destination, uploadId);
  const payload = Buffer.from("data");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, "payload"), payload);
  await writeFile(join(legacyDir, "receipt.json"), JSON.stringify({
    schemaVersion: 1, state: "promoted", uploadId, requestId, objectEtag: "abcd", objectBytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"), pickupClaimToken: claimToken,
  }));
  const result = runWorker(value.env);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(await readFile(join(legacyDir, "receipt.json"), "utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.state, "accepted");
  assert.equal(receipt.payloadName, "payload");
  assert.deepEqual(await readFile(join(legacyDir, "payload")), payload);
});

test("incoming pickup preserves a payload named receipt.json under its fixed payload directory", async (t) => {
  if (!canRunWorkerFixtures) {
    t.skip("Windows host does not provide the TrueNAS POSIX runtime; Linux container CI exercises the worker fixture");
    return;
  }
  const value = await fixture({ metadata: { requestid: requestId, originalname: "receipt.json" } });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = runWorker(value.env);
  assert.equal(result.status, 0, result.stderr);
  const finalDir = join(value.destination, requestId, uploadId);
  const receipt = JSON.parse(await readFile(join(finalDir, "receipt.json"), "utf8"));
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.payloadName, "receipt.json");
  assert.deepEqual(await readFile(join(finalDir, "payload", "receipt.json")), Buffer.from("data"));
});

test("incoming pickup rejects metadata names longer than 255 UTF-8 bytes before downloading", async (t) => {
  if (!canRunWorkerFixtures) {
    t.skip("Windows host does not provide the TrueNAS POSIX runtime; Linux container CI exercises the worker fixture");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "incoming-pickup-utf8-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const getLog = join(root, "download.log");
  const value = await fixture({ metadata: { requestid: requestId, originalname: "é".repeat(128) }, getLog });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = runWorker(value.env);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(getLog), "a name exceeding 255 UTF-8 bytes must not start a source read");
});

test("incoming pickup ignores a valid-looking receipt planted in private staging", async (t) => {
  if (!canRunWorkerFixtures) {
    t.skip("Windows host does not provide the TrueNAS POSIX runtime; Linux container CI exercises the worker fixture");
    return;
  }
  const value = await fixture({ list: [] });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const staged = join(value.staging, "job-planted");
  const payload = Buffer.from("data");
  await mkdir(join(staged, "payload"), { recursive: true });
  await writeFile(join(staged, "payload", "photo.jpg"), payload);
  await writeFile(join(staged, "receipt.json"), JSON.stringify({
    schemaVersion: 3, state: "promoted", uploadId, requestId, objectEtag: "abcd", objectBytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"), pickupClaimToken: claimToken, payloadName: "photo.jpg",
  }));
  const callbackLog = join(value.root, "callback.log");
  await executable(join(value.root, "bin", "curl"), `#!/usr/bin/env bash\nprintf callback >> '${callbackLog}'\nprintf '200'\n`);
  const result = runWorker(value.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(join(staged, "receipt.json"), "utf8")).state, "promoted");
  await assert.rejects(readFile(callbackLog), "staging receipts must not be accepted or acknowledged");
});

test("incoming pickup fails closed when a local destination appears during promotion", async (t) => {
  if (!canRunWorkerFixtures) {
    t.skip("Windows host does not provide the TrueNAS POSIX runtime; Linux container CI exercises the worker fixture");
    return;
  }
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const deleteLog = join(value.root, "delete.log");
  const aws = join(value.root, "bin", "aws");
  await executable(aws, `#!/usr/bin/env bash
set -eu
case " $* " in
  *" list-objects-v2 "*) printf '%s\\n' '${JSON.stringify({ Contents: [{ Key: objectKey, Size: 4 }] })}' ;;
  *" head-object "*) printf '%s\\n' '${JSON.stringify({ ContentLength: 4, ETag: '"abcd"', Metadata: { requestid: requestId, originalname: "photo.jpg" } })}' ;;
  *" get-object "*) printf 'data' > "${"${@: -1}"}" ;;
  *" delete-object "*) printf 'deleted\\n' >> '${deleteLog}' ;;
  *) exit 1 ;;
esac
`);
  // The fixture uses its own root; make clamscan create that final destination.
  const raceClam = join(value.root, "bin", "clamscan");
  await executable(raceClam, `#!/usr/bin/env bash\nmkdir -p '${join(value.destination, requestId, uploadId)}'\nexit 0\n`);
  const output = runWorker(value.env);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stderr, /local promotion could not be completed/);
  const entries = await readdir(join(value.destination, requestId, uploadId));
  assert.deepEqual(entries, [], "an empty raced destination must remain untouched, not be replaced or gain a nested stage");
  assert.deepEqual(await readdir(value.staging), [], "failed no-replace promotion must discard the scanned private stage");
  await assert.rejects(readFile(deleteLog), "remote source must remain when no-clobber promotion fails");
});

test("incoming pickup rejects a destination that resolves through a symlink", async (t) => {
  if (!canRunWorkerFixtures) {
    t.skip("Windows host does not provide the TrueNAS POSIX runtime; Linux container CI exercises the worker fixture");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "incoming-pickup-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "quarantine");
  const link = join(root, "final");
  await mkdir(target);
  try {
    await symlink(target, link, "dir");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      t.skip("Windows host does not permit an unprivileged test symlink; Linux CI exercises this path");
      return;
    }
    throw error;
  }
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = spawnSync("bash", [worker, "--once"], {
    env: { ...value.env, INCOMING_PICKUP_DESTINATION_DIR: link }, encoding: "utf8", stdio: "pipe",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /canonical private directory outside a quarantine segment/);
});
