// Local end-to-end server for the controller app: the real /api/v1/device/* handlers (device-routes.mjs) over
// Miniflare D1 + R2 with migrations 0001/0002, and a stand-in for Ops' StaffDirectory. Test only.
//   node dev/local-device-e2e.mjs [--port 8787]
// Then `adb reverse tcp:8787 tcp:8787` and open the app with the server extra pointing at http://127.0.0.1:8787.
// Approve a code at http://127.0.0.1:8787/local/approve (stands in for the Ops Flight logs approval prompt).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Miniflare } from 'miniflare';
import { handleDeviceRequest } from '../src/worker/device-routes.mjs';
import * as device from '../src/worker/device.mjs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8787;
const root = path.join(process.env.LOCALAPPDATA || '.', 'LedgeTop', 'logs-local-e2e');
fs.mkdirSync(root, { recursive: true });

const PILOTS = new Map([['staff-beau', { username: 'bkoltz', name: 'Beau', active: true }], ['staff-kollin', { username: 'kstirn', name: 'Kollin', active: true }]]);
const directory = {
  async resolvePilotUsername(username) {
    const hits = [...PILOTS].filter(([, p]) => p.username === username && p.active);
    return hits.length === 1 ? { staffId: hits[0][0] } : null;
  },
  async isActiveStaff(staffId) { return PILOTS.get(staffId)?.active === true; },
};

const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: { LOGS_DB: 'logs-e2e' }, r2Buckets: { LOGS_BUCKET: 'logs-e2e' }, d1Persist: path.join(root, 'd1'), r2Persist: path.join(root, 'r2') });
const db = await runtime.getD1Database('LOGS_DB'), bucket = await runtime.getR2Bucket('LOGS_BUCKET');
const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='raw_logs'").first();
if (!existing) for (const file of ['0001_flight_logs.sql', '0002_devices_raw_logs.sql']) {
  const sql = fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '');
  for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
}
const env = { LOGS_DB: db, LOGS_BUCKET: bucket, OPS_DIRECTORY: directory };
const actor = staffId => ({ staffId, permissions: ['flight_logs.view'] });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function approvePage() {
  let rows = '';
  for (const [staffId, p] of PILOTS) {
    const pending = await device.pendingSignIns(env, actor(staffId));
    for (const item of pending.items) rows += `<li>${esc(p.name)} (${esc(p.username)}): code <b>${esc(item.code)}</b> from ${esc(item.model)}
      <form method="post" action="/local/decide" style="display:inline"><input type="hidden" name="staff" value="${esc(staffId)}"><input type="hidden" name="id" value="${esc(item.id)}">
      <button name="approve" value="1">Approve</button> <button name="approve" value="0">Deny</button></form></li>`;
    const devices = await device.listDevices(env, actor(staffId), {});
    for (const d of devices.items ?? []) rows += `<li>${esc(p.name)} controller ${esc(d.model)} ${esc(d.status)} · last seen ${esc(d.lastSeenAt ?? d.last_seen_at ?? '')}</li>`;
  }
  const logs = await db.prepare('SELECT pilot_id, COUNT(*) AS n, SUM(size_bytes) AS bytes FROM raw_logs GROUP BY pilot_id').all();
  for (const r of logs.results) rows += `<li>Raw logs for ${esc(PILOTS.get(r.pilot_id)?.name ?? r.pilot_id)}: ${r.n} (${Math.round(r.bytes / 1024)} KB)</li>`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="4"><title>Local approvals</title><body style="font:16px system-ui;background:#0b0d10;color:#f5f3ef;padding:24px">
    <h1>Local controller approvals (test)</h1><ul>${rows || '<li>Nothing pending.</li>'}</ul></body>`;
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (url.pathname === '/local/approve') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(await approvePage()); }
    if (url.pathname === '/local/decide' && req.method === 'POST') {
      const form = new URLSearchParams(body.toString());
      await device.decideSignIn(env, actor(form.get('staff')), { signInId: form.get('id'), approve: form.get('approve') === '1' });
      res.writeHead(303, { location: '/local/approve' }); return res.end();
    }
    if (url.pathname === '/local/forget-newest' && req.method === 'POST') {   // boot test: make one log "missing" again
      const row = await db.prepare('SELECT sha256, r2_key FROM raw_logs ORDER BY uploaded_at DESC LIMIT 1').first();
      if (row) { await db.prepare('DELETE FROM raw_logs WHERE sha256 = ?').bind(row.sha256).run(); await bucket.delete(row.r2_key); }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ forgot: row ? 1 : 0 }));
    }
    if (url.pathname === '/local/revoke' && req.method === 'POST') {   // stands in for Ops → Controllers → Sign out
      const staffId = url.searchParams.get('staff');
      const active = await db.prepare("SELECT id FROM devices WHERE pilot_id = ? AND status = 'active'").bind(staffId).all();
      for (const d of active.results) await device.revokeDevice(env, actor(staffId), d.id);
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ revoked: active.results.length }));
    }
    if (url.pathname === '/local/devices') {
      const rows = (await db.prepare('SELECT pilot_id, model, status, created_at, last_seen_at FROM devices').all()).results;
      const logs = (await db.prepare('SELECT pilot_id, COUNT(*) AS n, MAX(uploaded_at) AS newest FROM raw_logs GROUP BY pilot_id').all()).results;
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ devices: rows, logs }));
    }
    const request = new Request(`https://logs.local.test${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const response = await handleDeviceRequest(request, env);
    if (!response) { res.writeHead(404); return res.end('not found'); }
    const out = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(out);
    console.log(new Date().toISOString(), req.method, url.pathname.replace(/[0-9a-f]{64}/, '<sha>').replace(/sign-in\/[^/]+$/, 'sign-in/<id>'), response.status);
  } catch (error) {
    console.error('error', error?.message);
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'local_error' }));
  }
}).listen(port, '127.0.0.1', () => console.log(`local device e2e on http://127.0.0.1:${port} (approve at /local/approve)`));
