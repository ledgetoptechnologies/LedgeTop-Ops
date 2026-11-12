#!/usr/bin/env node
// Local preview of Operations → Flight logs on real data. The real logs service runs inside workerd
// (dev/preview-worker.mjs) against a local, persisted D1 database and R2 bucket. An OpenDroneLog backup is
// imported the way the Ops import does it (batches of 50, then one track per flight), and the built Ops
// client is served with a stand-in staff session. Test only: binds 127.0.0.1.
//
// Usage: node apps/logs/dev/local-ops-preview.mjs --odl-backup <file> [--port 4180] [--data <dir>] [--mapbox-token pk...]
// Build the client first: (cd apps/operations && npm run build)
// Re-running after an interrupted import resumes it (the service's resume path), with no duplicates.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { openOdlBackup, buildImport, streamTelemetry } from '../src/odl/index.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const PORT = Number(option('port', 4180));
const DATA = path.resolve(option('data', path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'LedgeTop', 'logs-local-preview')));
const BACKUP = option('odl-backup', null);
const MAPBOX = option('mapbox-token', process.env.MAPBOX_TOKEN ?? null);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '../../operations/dist/client');
const PILOTS = { beau: 'Beau', kollin: 'Kollin' };
const importer = { staffId: 'beau', permissions: ['flight_logs.view', 'flight_logs.import'] };
const viewer = { staffId: 'beau', permissions: ['flight_logs.view'] };

fs.mkdirSync(DATA, { recursive: true });
const runtime = new Miniflare({
  modules: true, scriptPath: path.join(here, 'preview-worker.mjs'), modulesRoot: path.resolve(here, '..'), compatibilityDate: '2026-07-22',
  modulesRules: [{ type: 'ESModule', include: ['**/*.mjs'] }],
  d1Databases: { LOGS_DB: 'logs-preview' }, r2Buckets: { LOGS_BUCKET: 'logs-preview' },
  d1Persist: path.join(DATA, 'd1'), r2Persist: path.join(DATA, 'r2'),
  bindings: { KEYCHAIN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') }, // local test key only
});

async function call(fn, actor, ...rest) {
  const response = await runtime.dispatchFetch(`http://preview/rpc/${fn}`, { method: 'POST', body: JSON.stringify({ actor, args: rest }) });
  const body = await response.json();
  if (!body.ok) throw Object.assign(new Error(body.error.message), body.error);
  return body.value;
}

async function importBackup(file) {
  const started = Date.now();
  const backup = openOdlBackup(fs.readFileSync(file));
  const plan = await buildImport(backup, { pilot: { id: 'beau' } });
  const keys = new Map((await backup.keychains()).map(item => [item.fileHash, item]));
  const { importId } = await call('startImport', importer, { sourceSystem: 'opendronelog', pilotId: 'beau', expectedFlights: plan.flights.length });
  const messages = new Map();
  for (const m of plan.messages) messages.set(m.sourceFlightId, [...(messages.get(m.sourceFlightId) ?? []), m]);
  const ids = new Map(); let created = 0, resumed = 0, existing = 0;
  for (let i = 0; i < plan.flights.length; i += 50) {
    const flights = plan.flights.slice(i, i + 50);
    const result = await call('importFlights', importer, importId, { flights, messages: flights.flatMap(f => messages.get(f.source.flightId) ?? []),
      keychains: flights.flatMap(f => { const k = keys.get(f.source.fileHash); return k ? [{ fileHash: k.fileHash, key: k.key.reveal(), fetchedAt: k.fetchedAt }] : []; }) });
    for (const item of [...result.created, ...result.resumed]) ids.set(item.sourceFlightId, item.flightId);
    created += result.created.length; resumed += result.resumed.length; existing += result.existing.length;
    process.stdout.write(`\rFlights ${Math.min(i + 50, plan.flights.length)}/${plan.flights.length} (new ${created}, resumed ${resumed}, existing ${existing})`);
  }
  const flightSeconds = Math.round((Date.now() - started) / 1000);
  let tracks = 0;
  for await (const track of streamTelemetry(backup, { flightIds: new Set(ids.keys()) })) {
    const id = ids.get(track.sourceFlightId); if (!id) continue;
    const response = await runtime.dispatchFetch(`http://preview/track/${importId}/${id}`, { method: 'PUT', headers: { 'x-actor': JSON.stringify(importer) },
      body: gzipSync(JSON.stringify({ schema: 'ltds.logs.telemetry.v1', ...track })) });
    if (!(await response.json()).ok) throw new Error(`Track for ${id} was refused`);
    if (++tracks % 25 === 0) process.stdout.write(`\rTracks ${tracks}/${ids.size}        `);
  }
  const summary = await call('completeImport', importer, importId, { tracksExpected: tracks });
  console.log(`\nImported: flights in ${flightSeconds} s, everything in ${Math.round((Date.now() - started) / 1000)} s.`, summary);
}

const state = await (await runtime.dispatchFetch('http://preview/state')).json();
if (!state.migrated) {
  const sql = fs.readFileSync(path.resolve(here, '../migrations/0001_flight_logs.sql'), 'utf8').replace(/--.*$/gm, '');
  await runtime.dispatchFetch('http://preview/sql', { method: 'POST', body: JSON.stringify({ sql }) });
}
if (!state.completedImports) {
  if (!BACKUP) { console.error('No completed import yet: pass --odl-backup <file>.'); process.exit(1); }
  await importBackup(BACKUP);
}

const named = item => ({ ...item, pilotName: PILOTS[item.pilotId] ?? null });
const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost'), p = url.pathname, q = Object.fromEntries(url.searchParams);
  try {
    if (p === '/api/session') return json(res, 200, {
      user: { id: 'beau', email: 'preview@localhost', displayName: 'Beau (local preview)', status: 'Active', profileType: 'Employee', isAdministrator: false, permissions: ['flight_logs.view'], divisions: [] },
      csrfToken: 'preview', timezone: 'America/Chicago', mapStyleUrl: null, mapboxPublicToken: MAPBOX, capabilities: {} });
    if (p === '/api/admin/flight-logs/flights') { const page = await call('listFlights', viewer, q); return json(res, 200, { ...page, items: page.items.map(named) }); }
    if (p === '/api/admin/flight-logs/facets') { const f = await call('facets', viewer); return json(res, 200, { ...f, pilots: f.pilots.map(x => ({ ...x, pilotName: PILOTS[x.id] ?? null })) }); }
    if (p === '/api/admin/flight-logs/overview') return json(res, 200, await call('overview', viewer, q));
    const track = /^\/api\/admin\/flight-logs\/flights\/([A-Za-z0-9-]+)\/track$/.exec(p);
    if (track) {
      const response = await runtime.dispatchFetch(`http://preview/track/${track[1]}`, { headers: { 'x-actor': JSON.stringify(viewer) } });
      if (!response.ok) return json(res, response.status, { error: 'This flight has no stored track.' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const flight = /^\/api\/admin\/flight-logs\/flights\/([A-Za-z0-9-]+)$/.exec(p);
    if (flight) return json(res, 200, named(await call('getFlight', viewer, flight[1])));
    if (p.startsWith('/api/')) return json(res, 404, { error: 'Not part of the flight-log preview' });
    let file = path.resolve(CLIENT, `.${decodeURIComponent(p)}`);
    if (!file.startsWith(CLIENT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(CLIENT, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    json(res, error.status ?? 500, { error: error.message ?? 'Preview error' });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Flight logs preview on http://localhost:${PORT}/fleet (data: ${DATA})`));
