import test from "node:test";
import assert from "node:assert/strict";
import {
  createRequestAttempt,
  markRequestAttemptUncertain,
  requestAttemptFailureIsDefinite,
} from "../src/client/request-retry-state.ts";

test("uncertain retries preserve the exact payload and idempotency key", () => {
  const first = createRequestAttempt("service", "key-1", '{"details":"one"}');
  const uncertain = markRequestAttemptUncertain(first);
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uncertain.key, first.key);
  assert.equal(uncertain.body, first.body);
  assert.equal(markRequestAttemptUncertain(uncertain), uncertain);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(uncertain));
});

test("only proven first-send rejection releases the attempt", () => {
  const first = createRequestAttempt("inquiry", "key-2", '{"details":"two"}');
  for (const status of [400, 404, 405, 422]) assert.equal(requestAttemptFailureIsDefinite(first, status), true);
  assert.equal(requestAttemptFailureIsDefinite(first, 409, "catalog_changed"), true);
  assert.equal(requestAttemptFailureIsDefinite(first, 409, "idempotency_conflict"), true);
  for (const [status, code] of [[409, undefined], [409, "authority_changed"], [401, undefined], [403, undefined], [500, undefined], [0, undefined]]) {
    assert.equal(requestAttemptFailureIsDefinite(first, status, code), false, `${status}/${code}`);
  }
});

test("all failures after uncertain delivery retain the attempt", () => {
  const uncertain = markRequestAttemptUncertain(createRequestAttempt("service", "key-3", "{}"));
  for (const status of [400, 401, 403, 404, 405, 409, 422, 500, 0]) {
    for (const code of [undefined, "catalog_changed", "idempotency_conflict", "authority_changed"]) {
      assert.equal(requestAttemptFailureIsDefinite(uncertain, status, code), false, `${status}/${code}`);
    }
  }
});

test("attempt creation rejects empty or invalid payloads", () => {
  assert.throws(() => createRequestAttempt("service", "", "{}"), TypeError);
  assert.throws(() => createRequestAttempt("inquiry", "key", ""), TypeError);
  assert.throws(() => createRequestAttempt("other", "key", "{}"), TypeError);
});
