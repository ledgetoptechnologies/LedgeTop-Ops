// Test-only preload for the 0227..0244 command line (`node --import`). It is never imported by the tool.
// Every network attempt is recorded in OPS_TEST_NETWORK_LOG (method and kind only, never headers) and refused.
// With OPS_TEST_D1_SQLITE, requests to the Cloudflare D1 API are answered from that local SQLite file instead, and
// batches are applied only with OPS_TEST_D1_WRITES=1. OPS_TEST_FETCH_HANGS=1 makes a request that never settles.
// With OPS_TEST_LOOPBACK_PORT, requests to the Cloudflare D1 API go to that port on 127.0.0.1 instead, and only there.
// OPS_TEST_RECEIPT_FAILS makes one kind of receipt operation fail and records each failure: open, fsync, close,
// readback, rename, reread, enospc:<bytes>, edquot:<bytes>, zero:<bytes> (a file that takes only that many bytes), or
// short (writes of at most 100 bytes, which must still succeed). OPS_TEST_RECEIPT_FAILS_AFTER=<n> lets the first n
// receipt writes succeed.
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const LOG = process.env.OPS_TEST_NETWORK_LOG;
if (!LOG) throw new Error('OPS_TEST_NETWORK_LOG is required');
const record = entry => fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
const refuse = kind => function refused() { record({ kind }); throw new Error('network refused by the test preload'); };
const LOOPBACK = Number(process.env.OPS_TEST_LOOPBACK_PORT ?? 0), connect = net.Socket.prototype.connect, refuseSocket = refuse('socket');
net.Socket.prototype.connect = function guarded(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (LOOPBACK > 0 && Number(options?.port) === LOOPBACK && (options.host ?? options.hostname) === '127.0.0.1') return connect.apply(this, args);
  return refuseSocket();
};
dgram.Socket.prototype.send = refuse('datagram');
dgram.Socket.prototype.connect = refuse('datagram');
for (const target of [dns, dns.promises]) for (const name of Object.keys(target))
  if (/^(?:lookup|resolve|reverse)/u.test(name) && typeof target[name] === 'function') target[name] = refuse('dns');
const [failing, limit] = (process.env.OPS_TEST_RECEIPT_FAILS ?? '').split(':');
if (failing) {
  const real = { ...fs }, after = Number(process.env.OPS_TEST_RECEIPT_FAILS_AFTER ?? 0), open = new Set(), renamed = new Set();
  let writes = 0;
  const now = () => writes > after;
  const broken = code => { record({ kind: `receipt-${failing}` }); throw Object.assign(new Error('synthetic disk failure'), { code }); };
  const isNext = file => typeof file === 'string' && file.endsWith('.next');
  fs.openSync = (file, ...rest) => {
    // Reading a file back also opens it; only the exclusive creation is a receipt write.
    if (!isNext(file) || rest[0] !== 'wx') return real.openSync(file, ...rest);
    writes++;
    if (failing === 'open' && now()) broken('EACCES');
    const fd = real.openSync(file, ...rest);
    open.add(fd);
    return fd;
  };
  fs.writeSync = (fd, bytes, offset, length, position) => {
    if (!open.has(fd) || !now() || !['short', 'zero', 'enospc', 'edquot'].includes(failing)) return real.writeSync(fd, bytes, offset, length, position);
    if (failing === 'short') return real.writeSync(fd, bytes, offset, Math.min(length, 100), position);
    const room = Number(limit) - position;
    if (room > 0) return real.writeSync(fd, bytes, offset, Math.min(length, room), position);
    if (failing === 'zero') { record({ kind: 'receipt-zero' }); return 0; }
    return broken(failing.toUpperCase());
  };
  fs.fsyncSync = fd => (failing === 'fsync' && open.has(fd) && now() ? broken('EIO') : real.fsyncSync(fd));
  fs.closeSync = fd => {
    const mine = open.delete(fd);
    real.closeSync(fd);
    if (failing === 'close' && mine && now()) broken('EIO');
  };
  fs.readFileSync = (file, ...rest) => {
    const bytes = real.readFileSync(file, ...rest);
    if (!now() || !((failing === 'readback' && isNext(file)) || (failing === 'reread' && renamed.has(file)))) return bytes;
    record({ kind: `receipt-${failing}` });
    return bytes.subarray(0, -1);
  };
  fs.renameSync = (from, to) => {
    if (failing === 'rename' && isNext(from) && now()) broken('EROFS');
    real.renameSync(from, to);
    if (isNext(from) && now()) renamed.add(to);
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
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input), method = init.method ?? 'GET';
  record({ kind: 'fetch', method, url: url.replace(/[a-f0-9]{32}/u, '<account>'), auth: /^Bearer .{20,}$/u.test(init.headers?.Authorization ?? '') });
  if (process.env.OPS_TEST_FETCH_HANGS === '1') return new Promise(() => {});
  if (LOOPBACK > 0 && API.test(url)) return realFetch(`http://127.0.0.1:${LOOPBACK}/`, init);
  if (process.env.OPS_TEST_D1_SQLITE && API.test(url)) return answer(url, init);
  throw new Error('network refused by the test preload');
};
