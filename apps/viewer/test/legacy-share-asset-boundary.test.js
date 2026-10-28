'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const auth = require('../server/auth');
const assets = require('../server/assets');
const store = require('../server/store');
const shareStore = require('../server/shareStore');

test('legacy share asset URLs and cookies stay within listed assets and camera permission', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-legacy-share-'));
  const previousProject = store.getById;
  const previousShare = shareStore.getById;
  const previousLive = shareStore.isLive;
  const project = {
    id: 'legacy-project',
    assetRoots: { derivatives: root },
    relAssets: {
      glb: { root: 'derivatives', rel: 'public.glb' },
      shots: { root: 'derivatives', rel: 'shots/list.json' },
    },
  };
  const share = { id: 'legacy-share', viewerProjectId: project.id, permissions: { cameras: false } };
  store.getById = (id) => id === project.id ? project : null;
  shareStore.getById = (id) => id === share.id ? share : null;
  shareStore.isLive = (value) => value === share;
  assets.setRepository({ resolveModelId: (id) => id, rateLimited: () => false,
    getViewerSessionByHash: () => null, viewerSessionLive: () => false });
  for (const [name, contents] of [['public.glb', 'public'], ['hidden.glb', 'hidden'], ['shots/list.json', 'camera'], ['shots/report.pdf', 'private']]) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const app = express();
  app.use((req, _res, next) => { req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => part.trim().split('='))); next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.getById = previousProject;
    shareStore.getById = previousShare;
    shareStore.isLive = previousLive;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = auth.sign({ kind: 'share-asset', shareId: share.id, viewerProjectId: project.id }, 60_000);
  const cookie = auth.sign({ shareId: share.id, viewerProjectId: project.id }, 60_000);
  for (const [prefix, headers] of [
    [`/session-assets/${encodeURIComponent(token)}`, {}],
    ['/assets', { Cookie: `ltds_share=${cookie}` }],
  ]) {
    const url = `${base}${prefix}/${project.id}/derivatives/`;
    const permitted = await fetch(url + 'public.glb', { headers });
    assert.equal(permitted.status, 200, await permitted.text());
    const hidden = await fetch(url + 'hidden.glb', { headers });
    assert.equal(hidden.status, 403);
    await hidden.text();
    const shots = await fetch(url + 'shots/list.json', { headers });
    assert.equal(shots.status, 403);
    await shots.text();
  }
  share.permissions.cameras = true;
  const tokenPrefix = `${base}/session-assets/${encodeURIComponent(token)}/${project.id}/derivatives/`;
  assert.equal((await fetch(tokenPrefix + 'shots/list.json')).status, 200);
  assert.equal((await fetch(tokenPrefix + 'shots/report.pdf')).status, 403,
    'a sibling of the listed camera file is not a public asset');
});
