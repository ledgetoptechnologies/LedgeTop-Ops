import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./incoming-pickup-worker.sh", import.meta.url), "utf8");

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
  position("INCOMING_PICKUP_MAX_SOURCE_BYTES");
  position("INCOMING_PICKUP_SCAN_TIMEOUT_SECONDS");
  position("INCOMING_PICKUP_OVERSIZE_RETRY_SECONDS");

  const scan = position("clamscan --no-summary --infected");
  const durablePromotion = position('write_receipt "$CURRENT_STAGE/receipt.json" "promoted"');
  const deletion = position('delete_exact_object "$key"');
  const receipt = position('post_acceptance "$upload_id" "$digest"');
  assert.ok(scan < durablePromotion, "scan must precede local promotion");
  assert.ok(durablePromotion < deletion, "local promotion must precede remote deletion");
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
});

test("incoming pickup binds lifecycle callbacks to a persisted, renewable claim", () => {
  assert.match(source, /claimToken/);
  assert.match(source, /new_claim_token\(\)/);
  assert.match(source, /write_claim_marker/);
  assert.match(source, /claim_token_for_identity/);
  assert.match(source, /state\":\"heartbeat/);
  assert.match(source, /while sleep 300; do/);
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
  assert.match(source, /cloudflarestorage/);
  assert.ok(source.includes("local paths, request IDs, content, credentials"));
  assert.match(source, /INCOMING_PICKUP_SECRET/);
  assert.doesNotMatch(source, /--header "Authorization: Bearer \$INCOMING_PICKUP_SECRET"/);
  assert.match(source, /curl --config "\$config_file"/);
  assert.match(source, /PICKUP_CALLBACK_PAYLOAD/);
  assert.match(source, /PICKUP_CLAIM_TOKEN/);
  assert.doesNotMatch(source, /\$payload" <<'PY'/);
});
