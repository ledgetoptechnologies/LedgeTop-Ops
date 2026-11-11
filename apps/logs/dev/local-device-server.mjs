#!/usr/bin/env node
// Local test server for the Ledge Top Logs controller app. Test only: it binds 127.0.0.1, and the
// controller reaches it over USB with `adb reverse tcp:8787 tcp:8787`, so nothing is exposed on the network.
//
// It mimics the planned device API on logs.ledgetop.app:
// - TV-style pairing: the controller shows a code, and you approve it for a pilot on http://localhost:8787.
// - "Which of these do you already have?" by SHA-256, then a write-once upload of each missing raw log.
// - Optionally matches uploads to an OpenDroneLog backup (ODL's file_hash is the SHA-256 of the raw log).
//
// Usage: node apps/logs/dev/local-device-server.mjs [--data <dir>] [--odl-backup <file>] [--port 8787]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const PORT = Number(option('port', 8787));
const DATA = path.resolve(option('data', path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'LedgeTop', 'logs-local-test')));
const ODL_BACKUP = option('odl-backup', null);
const PILOTS = [{ id: 'beau', name: 'Beau' }, { id: 'kollin', name: 'Kollin' }];
const MAX_LOG_BYTES = 200 * 1024 * 1024;
const CODE_TTL_MS = 10 * 60 * 1000;

fs.mkdirSync(path.join(DATA, 'raw'), { recursive: true });
const STATE_FILE = path.join(DATA, 'state.json');
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { devices: {}, logs: {}, events: [] };
const pairings = new Map(); // pairId -> { code, pollToken, device, expiresAt, approved: { token, pilot } | null }
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const event = (text) => { state.events.unshift({ at: new Date().toISOString(), text }); state.events.length = Math.min(state.events.length, 200); save(); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

// ODL flights by file hash, so an upload can be matched to an imported flight.
let odl = new Map();
if (ODL_BACKUP) {
  const { openOdlBackup, buildImport } = await import('../src/odl/index.mjs');
  const backup = openOdlBackup(fs.readFileSync(ODL_BACKUP));
  const plan = await buildImport(backup, { pilot: { id: 'odl-backup' } });
  for (const flight of plan.flights) if (flight.source.fileHash)
    odl.set(flight.source.fileHash, { name: flight.displayName, startedAt: flight.startedAt, aircraft: flight.aircraft?.name ?? flight.aircraft?.model ?? null });
  console.log(`Loaded ${odl.size} OpenDroneLog flight hashes from the backup.`);
}

function code() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ', pick = n => Array.from(crypto.randomBytes(n), b => letters[b % letters.length]).join('');
  return `${pick(3)}-${String(crypto.randomInt(0, 1000)).padStart(3, '0')}`;
}
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('too_large'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const json = async req => { try { return JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}'); } catch { return {}; } };
function device(req) {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  return bearer ? Object.values(state.devices).find(item => item.tokenHash === sha256(bearer) && !item.revoked) ?? null : null;
}
const flightTime = name => { const m = /(\d{4}-\d{2}-\d{2})_\[(\d{2})-(\d{2})-(\d{2})\]/.exec(name ?? ''); return m ? `${m[1]} ${m[2]}:${m[3]}:${m[4]}` : null; };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page() {
  const now = Date.now(), pending = [...pairings.values()].filter(p => !p.approved && p.expiresAt > now);
  const logs = Object.values(state.logs).sort((a, b) => (b.flightTime ?? '').localeCompare(a.flightTime ?? ''));
  const matched = logs.filter(log => odl.has(log.sha256)).length;
  const row = log => { const m = odl.get(log.sha256);
    return `<tr><td>${escape(log.flightTime ?? '—')}</td><td>${escape(log.name)}</td><td>${escape(log.pilotName)}</td><td>${(log.size / 1048576).toFixed(1)} MB</td>
      <td><code>${log.sha256.slice(0, 12)}…</code></td><td>${m ? `✔ ${escape(m.name ?? '')} <small>${escape(m.aircraft ?? '')}</small>` : odl.size ? 'Not in ODL backup' : '—'}</td></tr>`; };
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ledge Top Logs (local test)</title>
<meta http-equiv="refresh" content="10"><style>
body{font:15px/1.45 Inter,system-ui,sans-serif;margin:0;background:#f4f5f7;color:#121417}header{background:#070707;color:#f5f3ef;padding:14px 20px;display:flex;gap:10px;align-items:center}
header b{font-size:17px}header small{color:#ee5007;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:11px;display:block}
main{max-width:1100px;margin:0 auto;padding:20px}section{background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:16px 18px;margin-bottom:16px}
h2{font-size:16px;margin:0 0 10px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-top:1px solid #eef0f2;font-size:14px}th{color:#5a636e;font-weight:600}
.code{font:700 28px ui-monospace,monospace;letter-spacing:.08em}button{background:#cc4706;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
select{padding:7px;border-radius:8px;border:1px solid #c9ced4}.muted{color:#5a636e}form{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0}</style>
<header><svg width="34" height="34" viewBox="238.5 226 776 776"><g fill="none" stroke-width="56"><path stroke="#f5f3ef" d="M273.5 655V370.5a99 99 0 0 1 99-99H605M979.5 583v274.5a99 99 0 0 1-99 99H650M605 956.5H372.5a99 99 0 0 1-99-99V703"/><path stroke="#ee5007" d="M650 271.5h230.5a99 99 0 0 1 99 99V538"/></g><path fill="#f5f3ef" d="M365 370l93 92v244h135l66 94H418l-53-54zM503 453h349l54 88H780v332l-96-100V541H563z"/></svg>
<div><b>Ledge Top</b><small>Logs · local test</small></div></header><main>
<section><h2>Controllers waiting for a pilot</h2>${pending.length ? pending.map(p => `<form method="post" action="/approve"><span class="code">${escape(p.code)}</span>
<span class="muted">${escape(p.device.model)} · ${escape(p.device.name)}</span><input type="hidden" name="pairId" value="${escape(p.pairId)}">
<select name="pilot">${PILOTS.map(x => `<option value="${x.id}">${x.name}</option>`).join('')}</select><button>Approve</button></form>`).join('') : '<p class="muted">No codes waiting. Tap “Sign in” or “Switch pilot” on the controller.</p>'}</section>
<section><h2>Signed-in controllers</h2>${Object.values(state.devices).filter(d => !d.revoked).map(d => `<p>${escape(d.model)} · ${escape(d.name)} — <b>${escape(d.pilotName)}</b> <span class="muted">since ${escape(d.signedInAt)}, last seen ${escape(d.lastSeenAt ?? 'never')}</span></p>`).join('') || '<p class="muted">None yet.</p>'}</section>
<section><h2>Raw logs received (${logs.length})</h2>${odl.size ? `<p class="muted">${matched} of ${logs.length} match a flight in the OpenDroneLog backup (${odl.size} flights) by SHA-256.</p>` : ''}
<table><tr><th>Flight</th><th>File</th><th>Pilot</th><th>Size</th><th>SHA-256</th><th>ODL match</th></tr>${logs.map(row).join('')}</table></section>
<section><h2>Activity</h2>${state.events.slice(0, 30).map(e => `<div class="muted">${escape(e.at)} — ${escape(e.text)}</div>`).join('')}</section>
<p class="muted">Data: ${escape(DATA)}. Test server only; the real service will be logs.ledgetop.app.</p></main>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`), route = `${req.method} ${url.pathname}`;
    if (route === 'GET /') return send(res, 200, page(), 'text/html; charset=utf-8');
    if (route === 'POST /approve') {
      const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'));
      const pairing = pairings.get(form.get('pairId') ?? ''), pilot = PILOTS.find(p => p.id === form.get('pilot'));
      if (pairing && pilot && !pairing.approved && pairing.expiresAt > Date.now()) {
        const deviceToken = token(), id = sha256(`${pairing.device.serial ?? pairing.device.name}`).slice(0, 16);
        state.devices[id] = { id, ...pairing.device, pilotId: pilot.id, pilotName: pilot.name, tokenHash: sha256(deviceToken), signedInAt: new Date().toISOString(), revoked: false };
        pairing.approved = { token: deviceToken, pilot };
        event(`${pilot.name} signed in on ${pairing.device.model} (${pairing.code})`);
      }
      res.writeHead(303, { Location: '/' }); return res.end();
    }
    if (route === 'POST /api/v1/device/pair/start') {
      const body = await json(req), pairId = crypto.randomUUID(), pollToken = token();
      const info = { name: String(body.deviceName ?? 'Controller').slice(0, 80), model: String(body.model ?? 'Android').slice(0, 80), serial: body.serial ? String(body.serial).slice(0, 80) : null };
      const pairing = { pairId, code: code(), pollToken, device: info, expiresAt: Date.now() + CODE_TTL_MS, approved: null };
      pairings.set(pairId, pairing); event(`Code ${pairing.code} shown on ${info.model}`);
      return send(res, 201, { pairId, code: pairing.code, pollToken, expiresInSeconds: CODE_TTL_MS / 1000 });
    }
    const poll = /^GET \/api\/v1\/device\/pair\/([0-9a-f-]{36})$/.exec(route);
    if (poll) {
      const pairing = pairings.get(poll[1]);
      if (!pairing || pairing.pollToken !== url.searchParams.get('poll')) return send(res, 404, { error: 'Unknown code' });
      if (pairing.approved) { pairings.delete(poll[1]); return send(res, 200, { status: 'approved', deviceToken: pairing.approved.token, pilot: pairing.approved.pilot }); }
      return send(res, 200, { status: pairing.expiresAt > Date.now() ? 'pending' : 'expired' });
    }
    if (url.pathname.startsWith('/api/v1/device/')) {
      const me = device(req);
      if (!me) return send(res, 401, { error: 'Sign in again on the controller.' });
      me.lastSeenAt = new Date().toISOString();
      if (route === 'GET /api/v1/device/me') { save(); return send(res, 200, { pilot: { id: me.pilotId, name: me.pilotName }, device: { model: me.model, name: me.name } }); }
      if (route === 'POST /api/v1/device/sign-out') { me.revoked = true; event(`${me.pilotName} signed out on ${me.model}`); return send(res, 200, { ok: true }); }
      if (route === 'POST /api/v1/device/have') {
        const files = (await json(req)).files;
        if (!Array.isArray(files) || files.length > 5000) return send(res, 400, { error: 'Send at most 5000 files.' });
        const missing = files.filter(f => /^[0-9a-f]{64}$/.test(f?.sha256 ?? '') && !state.logs[f.sha256]).map(f => f.sha256);
        save(); return send(res, 200, { missing });
      }
      const put = /^PUT \/api\/v1\/device\/logs\/([0-9a-f]{64})$/.exec(route);
      if (put) {
        const hash = put[1];
        if (state.logs[hash]) return send(res, 200, { stored: true, duplicate: true });
        const bytes = await readBody(req, MAX_LOG_BYTES);
        // The server checks the content against the hash it was promised before keeping anything.
        if (sha256(bytes) !== hash) return send(res, 422, { error: 'The file changed or was damaged in transit. It will be sent again.' });
        const file = path.join(DATA, 'raw', `${hash}.txt`);
        fs.writeFileSync(file, bytes, { flag: 'wx' }); // write-once
        const name = String(url.searchParams.get('name') ?? '').slice(0, 200);
        state.logs[hash] = { sha256: hash, name, size: bytes.length, flightTime: flightTime(name), pilotId: me.pilotId, pilotName: me.pilotName, device: me.model, uploadedAt: new Date().toISOString() };
        event(`${me.pilotName}: received ${name} (${(bytes.length / 1048576).toFixed(1)} MB)${odl.has(hash) ? ' — matches ODL' : ''}`);
        return send(res, 201, { stored: true });
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    send(res, error.status ?? 500, { error: error.status === 413 ? 'Too large' : 'Server error' });
    if (!error.status) console.error(error);
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Ledge Top Logs local test server on http://localhost:${PORT} (data: ${DATA})`));
