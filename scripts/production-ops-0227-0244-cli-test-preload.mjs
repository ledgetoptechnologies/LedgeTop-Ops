// Test-only preload for the 0227..0244 command line (`node --import`). It is never imported by the tool.
// Every network attempt is recorded in OPS_TEST_NETWORK_LOG (method and kind only, never headers) and refused.
// With OPS_TEST_D1_SQLITE, requests to the Cloudflare D1 API are answered from that local SQLite file instead, and
// batches are applied only with OPS_TEST_D1_WRITES=1. OPS_TEST_FETCH_HANGS=1 makes a request that never settles.
// OPS_TEST_RECEIPT_FAILS makes receipt operations fail and records each failure: write (truncate), fsync, readback,
// close, enospc:<bytes>, edquot:<bytes> and zero:<bytes> (a file that takes only that many bytes), or short (writes
// of at most 100 bytes, which must still succeed).
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const LOG = process.env.OPS_TEST_NETWORK_LOG;
if (!LOG) throw new Error('OPS_TEST_NETWORK_LOG is required');
const record = entry => fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
const refuse = kind => function refused() { record({ kind }); throw new Error('network refused by the test preload'); };
net.Socket.prototype.connect = refuse('socket');
dgram.Socket.prototype.send = refuse('datagram');
dgram.Socket.prototype.connect = refuse('datagram');
for (const target of [dns, dns.promises]) for (const name of Object.keys(target))
  if (/^(?:lookup|resolve|reverse)/u.test(name) && typeof target[name] === 'function') target[name] = refuse('dns');
const [failing, limit] = (process.env.OPS_TEST_RECEIPT_FAILS ?? '').split(':');
if (failing) {
  const { openSync, writeSync, readFileSync } = fs, receipts = new Set(), paths = new Set();
  const broken = code => { record({ kind: `receipt-${failing}` }); throw Object.assign(new Error('synthetic disk failure'), { code }); };
  fs.openSync = (...args) => { const fd = openSync(...args); if (args[1] === 'wx') { receipts.add(fd); paths.add(args[0]); } return fd; };
  const name = { write: 'ftruncateSync', close: 'closeSync', fsync: 'fsyncSync' }[failing];
  if (name) { const real = fs[name]; fs[name] = (fd, ...rest) => (receipts.has(fd) ? broken('EIO') : real(fd, ...rest)); }
  if (failing === 'readback') fs.readFileSync = (file, ...rest) => {
    const bytes = readFileSync(file, ...rest);
    if (!paths.has(file)) return bytes;
    record({ kind: 'receipt-readback' });
    return bytes.subarray(0, -1);
  };
  if (['short', 'zero', 'enospc', 'edquot'].includes(failing)) fs.writeSync = (fd, bytes, offset, length, position) => {
    if (!receipts.has(fd)) return writeSync(fd, bytes, offset, length, position);
    if (failing === 'short') return writeSync(fd, bytes, offset, Math.min(length, 100), position);
    const room = Number(limit) - position;
    if (room > 0) return writeSync(fd, bytes, offset, Math.min(length, room), position);
    if (failing === 'zero') { record({ kind: 'receipt-zero' }); return 0; }
    return broken(failing.toUpperCase());
  };
}
syncBuiltinESMExports();

const API = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/d1\/database\/([0-9a-f-]{36})(\/query)?$/u;
const meta = { rows_written: 0, changed_db: false, served_by_primary: true };
const reply = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

async function answer(url, init) {
  const { DatabaseSync } = await import('node:sqlite');
  const [, databaseId, query] = API.exec(url);
  if (!query) return reply({ success: true, result: { uuid: databaseId, name: process.env.OPS_TEST_D1_NAME } });
  const { batch } = JSON.parse(init.body);
  const last = batch.at(-1);
  const write = last.sql.startsWith('INSERT INTO d1_migrations');
  record({ kind: write ? 'batch' : 'read', statements: batch.length });
  if (write && process.env.OPS_TEST_D1_WRITES !== '1') throw new Error('write refused by the test preload');
  const db = new DatabaseSync(process.env.OPS_TEST_D1_SQLITE, { readOnly: !write });
  try {
    if (!write) return reply({ success: true, result: batch.map(item => ({ success: true, results: db.prepare(item.sql).all(), meta })) });
    db.exec('PRAGMA foreign_keys=ON');
    for (const item of batch.slice(0, -1)) db.exec(item.sql);
    db.prepare(last.sql).run(...last.params);
    return reply({ success: true, result: batch.map(() => ({ success: true, results: [], meta: { changes: 1 } })) });
  } finally { db.close(); }
}

if (process.env.OPS_TEST_FETCH_HANGS === '1') {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => { const timer = real(...args); timer.unref?.(); return timer; };
}
globalThis.fetch = async (input, init = {}) => {
  const url = String(input), method = init.method ?? 'GET';
  record({ kind: 'fetch', method, url: url.replace(/[a-f0-9]{32}/u, '<account>'), auth: /^Bearer .{20,}$/u.test(init.headers?.Authorization ?? '') });
  if (process.env.OPS_TEST_FETCH_HANGS === '1') return new Promise(() => {});
  if (process.env.OPS_TEST_D1_SQLITE && API.test(url)) return answer(url, init);
  throw new Error('network refused by the test preload');
};
