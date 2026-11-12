// Local end-to-end server that runs the REAL logs Worker (src/worker/index.mjs, its fetch handler and
// routing) inside workerd, with OPS_DIRECTORY as a real service binding to a stand-in StaffDirectory
// entrypoint: the same shape as staging. Test only.
//   node dev/local-device-worker-e2e.mjs [--port 8787]
// Shares its data with dev/local-device-e2e.mjs, so a controller signed in against either stays signed in.
// /local/* pages stand in for Ops (approve a code, sign a controller out) and run in Node against the same D1.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import * as device from '../src/worker/device.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8787;
const root = path.join(process.env.LOCALAPPDATA || '.', 'LedgeTop', 'logs-local-e2e');
fs.mkdirSync(root, { recursive: true });

const PILOTS = { 'staff-beau': { username: 'bkoltz', name: 'Beau', active: true }, 'staff-kollin': { username: 'kstirn', name: 'Kollin', active: true } };
// Stand-in for Ops' StaffDirectory entrypoint: ids only, exact usernames, active staff only.
const staffDirectoryScript = `
import { WorkerEntrypoint } from 'cloudflare:workers';
const PILOTS = ${JSON.stringify(PILOTS)};
export class StaffDirectory extends WorkerEntrypoint {
  resolvePilotUsername(username) {
    const value = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const hits = Object.entries(PILOTS).filter(([, p]) => p.username === value && p.active);
    return hits.length === 1 ? { staffId: hits[0][0] } : null;
  }
  isActiveStaff(staffId) { return PILOTS[staffId]?.active === true; }
}
export default { fetch() { return new Response('ops stand-in', { status: 404 }); } };`;

const runtime = new Miniflare({
  workers: [
    {
      name: 'ledge-top-logs-local', modules: true, scriptPath: path.resolve(here, '../src/worker/index.mjs'), modulesRoot: path.resolve(here, '..'),
      modulesRules: [{ type: 'ESModule', include: ['**/*.mjs'] }], compatibilityDate: '2026-07-22',
      d1Databases: { LOGS_DB: 'logs-e2e' }, r2Buckets: { LOGS_BUCKET: 'logs-e2e' },
      serviceBindings: { OPS_DIRECTORY: { name: 'ops-directory-standin', entrypoint: 'StaffDirectory' } },
    },
    { name: 'ops-directory-standin', modules: true, script: staffDirectoryScript, compatibilityDate: '2026-07-22' },
  ],
  d1Persist: path.join(root, 'd1'), r2Persist: path.join(root, 'r2'),
});
const db = await runtime.getD1Database('LOGS_DB', 'ledge-top-logs-local');
const existing = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='raw_logs'").first();
if (!existing) for (const file of ['0001_flight_logs.sql', '0002_devices_raw_logs.sql']) {
  const sql = fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '');
  for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
}
// Node-side stand-in for the Ops actions (approve, sign out), against the same D1.
const nodeDirectory = {
  async resolvePilotUsername(u) { const hits = Object.entries(PILOTS).filter(([, p]) => p.username === u && p.active); return hits.length === 1 ? { staffId: hits[0][0] } : null; },
  async isActiveStaff(id) { return PILOTS[id]?.active === true; },
};
const env = { LOGS_DB: db, LOGS_BUCKET: await runtime.getR2Bucket('LOGS_BUCKET', 'ledge-top-logs-local'), OPS_DIRECTORY: nodeDirectory };
const actor = staffId => ({ staffId, permissions: ['flight_logs.view'] });
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (url.pathname === '/local/pending') {
      const out = [];
      for (const staffId of Object.keys(PILOTS)) for (const item of (await device.pendingSignIns(env, actor(staffId))).items) out.push({ staffId, id: item.id, code: item.code, model: item.model });
      return json(res, { items: out });
    }
    if (url.pathname === '/local/decide' && req.method === 'POST') {
      const form = new URLSearchParams(body.toString());
      return json(res, await device.decideSignIn(env, actor(form.get('staff')), { signInId: form.get('id'), approve: form.get('approve') === '1' }));
    }
    if (url.pathname === '/local/revoke' && req.method === 'POST') {
      const staffId = url.searchParams.get('staff'), only = url.searchParams.get('createdBefore');
      const active = only
        ? await db.prepare("SELECT id FROM devices WHERE pilot_id = ? AND status = 'active' AND created_at < ?").bind(staffId, only).all()
        : await db.prepare("SELECT id FROM devices WHERE pilot_id = ? AND status = 'active'").bind(staffId).all();
      for (const d of active.results) await device.revokeDevice(env, actor(staffId), d.id);
      return json(res, { revoked: active.results.length });
    }
    if (url.pathname === '/local/forget-newest' && req.method === 'POST') {
      const row = await db.prepare('SELECT sha256, r2_key FROM raw_logs ORDER BY uploaded_at DESC LIMIT 1').first();
      if (row) { await db.prepare('DELETE FROM raw_logs WHERE sha256 = ?').bind(row.sha256).run(); await env.LOGS_BUCKET.delete(row.r2_key); }
      return json(res, { forgot: row ? 1 : 0 });
    }
    if (url.pathname === '/local/devices') {
      const devices = (await db.prepare('SELECT pilot_id, model, status, created_at, last_seen_at FROM devices').all()).results;
      const logs = (await db.prepare('SELECT pilot_id, COUNT(*) AS n, MAX(uploaded_at) AS newest FROM raw_logs GROUP BY pilot_id').all()).results;
      return json(res, { devices, logs });
    }
    // Everything else goes to the real Worker, exactly as the public route would deliver it.
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)));
    const response = await runtime.dispatchFetch(`https://logs.local.test${url.pathname}${url.search}`,
      { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const out = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(out);
    console.log(new Date().toISOString(), req.method, url.pathname.replace(/[0-9a-f]{64}/, '<sha>').replace(/sign-in\/[^/]+$/, 'sign-in/<id>'), response.status);
  } catch (error) {
    console.error('error', error?.message);
    json(res, { error: 'local_error' }, 500);
  }
}).listen(port, '127.0.0.1', () => console.log(`real logs Worker (workerd) on http://127.0.0.1:${port}`));
