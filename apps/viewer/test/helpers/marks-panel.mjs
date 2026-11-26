import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import auth from '../../server/auth.js';
import api from '../../server/viewerMarkApi.js';
import schema from '../../server/viewerMarkSchema.js';
import { mountViewerMarks } from '../../viewer-marks.mjs';
import { createMiniDocument } from './mini-dom.mjs';
import { createMiniLeaflet } from './mini-leaflet.mjs';

// The real Marks panel on a mini DOM, against the real API on an in-memory database.
export async function openMarksPanel(t, { rateLimited = () => false, maxRequestBytes, ...options } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES ('synthetic-model'),('other-model');");
  database.exec(schema.VIEWER_MARKS_SQL + schema.VIEWER_MARK_SHARING_SQL);
  const sessions = new Map();
  const repository = {
    database,
    getViewerSessionByHash: hash => sessions.get(hash),
    viewerSessionLive: record => !record.revoked,
    getModel: () => ({ status: 'ready', activeVersion: { id: 'synthetic-v1', status: 'ready' } }),
    rateLimited,
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1/marks', api.createViewerMarkApi(repository, { ...options, ...(maxRequestBytes && { maxRequestBytes }) }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); database.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const scope = (audience, subject, { permissions = { view: true, measure: true, personalMeasurements: true }, modelId = 'synthetic-model' } = {}) => {
    const token = randomUUID().replaceAll('-', '');
    const record = { audience, subject, modelId, modelVersionId: 'synthetic-v1', permissions,
      sourceAuthorization: audience === 'client' ? { type: 'direct_client_grant', id: 'grant-a', version: 1 } : null };
    sessions.set(auth.hashToken(token), record);
    return { mode: 'session', key: JSON.stringify([audience, subject, modelId, permissions.personalMeasurements === true]), token: () => token, record };
  };
  const requests = [];
  const request = (path, init) => fetch(base + path, { ...init, redirect: 'follow' });
  const mount = ({ dom = createMiniDocument(), units = () => 'imperial', map = true, request = null, georef = () => null, group = false, obstacles } = {}) => {
    // Most tests put several marks on one spot; those about groups ask for them.
    if (!group) { try { dom.window.localStorage.setItem('ltds.viewer.marks.group', 'off'); } catch { /* a test of blocked storage */ } }
    const panel = dom.document.createElement('div'), sidebar = dom.document.createElement('div'), overlay = dom.document.createElement('div');
    panel.append(sidebar, overlay);
    const leaflet = createMiniLeaflet(dom.document);
    const marks = mountViewerMarks({ panel: sidebar, overlay, L: leaflet.L, getMap: () => leaflet.map, units, georef, ...(obstacles && { obstacles }),
      request: (path, init) => { requests.push([init.method, path]); return (request || fetch)(base + path, { ...init, redirect: 'follow' }); } });
    if (map) marks.setView({ map: true });
    const q = selector => panel.querySelector(selector);
    const card = text => q('.viewer-mark-card').querySelectorAll('button').find(node => node.textContent === text);
    return { dom, panel, sidebar, overlay, marks, leaflet, card, store: marks.store, q,
      // The panel's own Undo, not the one beside Place several.
      button: text => panel.querySelectorAll('button').filter(node => node.textContent === text).sort((a, b) => Number(Boolean(b.closest('.viewer-mark-list-head'))) - Number(Boolean(a.closest('.viewer-mark-list-head'))))[0],
      bar: () => panel.querySelector('.viewer-mark-undo'),
      text: () => panel.textContent,
      values: () => [...panel.querySelectorAll('input'), ...panel.querySelectorAll('textarea')].map(node => node.value).join('\n'),
      async type(selector, value) { q(selector).value = value; await q(selector).fire('input'); },
      async place(coordinates) {
        q('[name=coordinates]').value = coordinates;
        await q('[name=coordinates]').fire('input');
        await q('.viewer-mark-coords').fire('submit');
      },
      save: () => q('.viewer-mark-form').fire('submit'),
      // Opens the card, and the editor when this person may edit.
      async show(name) { await panel.querySelector('[id=viewer-marks-list]').querySelectorAll('.viewer-mark-list-item').find(node => node.textContent.startsWith(name)).click(); },
      async open(name) { await this.show(name); if (!card('Edit').hidden) await card('Edit').click(); },
    };
  };
  return { mount, scope, database, requests, request };
}
