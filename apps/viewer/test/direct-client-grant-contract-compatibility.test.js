'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validDirectSnapshot } = require('../server/directClientGrantContract');

test('Operations unpaged grant lists are accepted with or without the optional grant cursor', () => {
  const result = { clients: [], clientsNextCursor: null, grants: [] };
  assert.equal(validDirectSnapshot(result, 'list'), true);
  assert.equal(validDirectSnapshot({ ...result, grantsNextCursor: null }, 'list'), true);
  assert.equal(validDirectSnapshot({ ...result, grantsNextCursor: 42 }, 'list'), false);
});
