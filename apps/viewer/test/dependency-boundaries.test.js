'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const proxyaddr = require('proxy-addr');
const qs = require('qs');
const { SourceMapConsumer, SourceNode } = require('source-map-js');

test('proxy trust rejects unrelated IPv4 addresses for mapped and zero-prefix IPv6 subnets', () => {
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1', '::ffff:10.0.0.0/104', '10.0.0.0/8']) {
    assert.equal(proxyaddr.compile(subnet)('198.51.100.25', 0), false, subnet);
  }
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    assert.equal(proxyaddr.compile(subnet)('10.1.2.3', 0), true, subnet);
    assert.equal(proxyaddr.compile(subnet)('::ffff:10.1.2.3', 0), true, subnet);
  }
});

test('Express preserves numeric-hop client identity and ordinary query parsing', async t => {
  const app = express();
  app.set('trust proxy', 1); // Same numeric-hop policy as server/index.js.
  app.get('/probe', (req, res) => res.json({ ip: req.ip, query: req.query }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/probe?limit=10&tags[]=map&tags[]=model`, {
    headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.25' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ip: '198.51.100.25', query: { limit: '10', tags: ['map', 'model'] } });
});

test('query limits cover comma arrays and hostile constructor fields remain serializable', () => {
  const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };
  for (const input of ['a[]=1,2,3,4', 'a=1,2,3,4']) assert.throws(() => qs.parse(input, options), RangeError);
  assert.deepEqual(qs.parse('a=1,2,3', options), { a: ['1', '2', '3'] });
  for (const parserOptions of [{ allowPrototypes: true }, { plainObjects: true }]) {
    const value = qs.parse('a[constructor][isBuffer]=1', parserOptions);
    assert.doesNotThrow(() => qs.stringify(value));
  }
  assert.equal(qs.stringify({ limit: 10, task: 'Flight model' }), 'limit=10&task=Flight%20model');
});

test('indexed source maps reject excessive and malformed section offsets and retain normal mappings', () => {
  const basic = { version: 3, sources: ['input.js'], sourcesContent: ['x();'], names: [], mappings: 'AAAA' };
  const indexed = line => ({ version: 3, sections: [{ offset: { line, column: 0 }, map: basic }] });
  for (const line of [Number.MAX_SAFE_INTEGER, -1, 0.5, Infinity, '1']) {
    assert.throws(() => new SourceMapConsumer(indexed(line)), /Section offset/);
  }
  const consumer = new SourceMapConsumer(indexed(0));
  assert.equal(SourceNode.fromStringWithSourceMap('x();', consumer).toString(), 'x();');
});
