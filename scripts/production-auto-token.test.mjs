import test from 'node:test';
import assert from 'node:assert/strict';
import { isGitHubHeaderCredential } from './production-auto-token.mjs';

const stateless = `ghs_${'1234567890'.repeat(50)}.${'abcdefghijklmnopqrstuvwxyz'.repeat(8)}.${'A'.repeat(160)}`;

test('accepts current dotted stateless and legacy opaque GitHub App tokens without parsing them', () => {
  assert.ok(stateless.length > 500);
  assert.equal(isGitHubHeaderCredential(stateless), true);
  assert.equal(isGitHubHeaderCredential('ghs_' + 'A'.repeat(40)), true);
});

test('rejects empty, short, whitespace, controls, CRLF, non-ASCII, and oversized header credentials', () => {
  for (const value of ['', 'short', 'x'.repeat(20) + ' ', 'x'.repeat(20) + '\t',
    'x'.repeat(20) + '\n', 'x'.repeat(20) + '\r\nInjected: yes', 'x'.repeat(20) + '\x7f',
    'x'.repeat(20) + 'é', 'x'.repeat(16_385)]) {
    assert.equal(isGitHubHeaderCredential(value), false);
  }
});
