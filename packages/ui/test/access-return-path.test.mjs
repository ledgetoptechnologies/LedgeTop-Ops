import assert from 'node:assert/strict';
import test from 'node:test';
import { safeAccessReturnPath } from '../src/access-return-path.ts';

const origin = 'https://ops.ledgetop.app';

test('keeps internal login and portal navigation, including encoded queries', () => {
  for (const value of ['/', '/account', '/portal', '/account/link-login',
    '/portal/requests?search=Jane%20Doe', '/portal/projects#details', '/%2F%2Fexample.invalid']) {
    assert.equal(safeAccessReturnPath(value), value);
    assert.equal(new URL(safeAccessReturnPath(value), origin).origin, origin);
  }
});

test('rejects external, protocol-relative, backslash and non-path destinations', () => {
  for (const value of [null, undefined, {}, 1, '', 'account', 'https://example.invalid',
    '//example.invalid', '/\\example.invalid', '\\example.invalid', 'javascript:alert(1)']) {
    assert.equal(safeAccessReturnPath(value), '/');
  }
});

test('rejects controls that URL parsing removes before determining the host', () => {
  for (const control of ['\t', '\r', '\n']) {
    for (const suffix of ['/example.invalid', '//example.invalid', '\\example.invalid']) {
      const input = '/' + control + suffix;
      // Establish the unsafe parser behavior this regression prevents.
      assert.notEqual(new URL(input, origin).origin, origin);
      assert.equal(safeAccessReturnPath(input), '/');
    }
  }
});

test('rejects control characters anywhere and normalizes ordinary dot segments', () => {
  for (let code = 0; code <= 31; code++) {
    assert.equal(safeAccessReturnPath('/portal?value=' + String.fromCharCode(code)), '/');
  }
  assert.equal(safeAccessReturnPath('/portal?value=\x7f'), '/');
  assert.equal(safeAccessReturnPath('/portal/../account'), '/account');
  assert.equal(safeAccessReturnPath('/portal/a b?q=a b'), '/portal/a%20b?q=a%20b');
});

test('never serializes a normalized path as a protocol-relative destination', () => {
  for (const value of ['/..//example.invalid', '/%2e%2e//example.invalid',
    '/a/..//example.invalid', '/..///example.invalid', '/a/%2e%2e//example.invalid']) {
    const destination = safeAccessReturnPath(value);
    assert.equal(destination, '/');
    assert.equal(new URL(destination, origin).origin, origin);
  }
});
