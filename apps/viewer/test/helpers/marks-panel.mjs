import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import auth from '../../server/auth.js';
import api from '../../server/viewerMarkApi.js';
import schema from '../../server/viewerMarkSchema.js';
import { mountViewerMarks } from '../../viewer-marks.mjs';
import { createMiniDocument } from './mini-dom.mjs';

// The real Marks panel on a mini DOM, against the real API on an in-memory database.
export async function openMarksPanel(t, options) {
  const database = new DatabaseSync(':memory:');
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES ('synthetic-model'),('other-model');");
  database.exec(schema.VIEWER_MARKS_SQL);
  const sessions = new Map();
  const repository = {
    database,
    getViewerSessionByHash: hash => sessions.get(hash),
    viewerSessionLive: record => !record.revoked,
    getModel: () => ({ status: 'ready', activeVersion: { id: 'synthetic-v1', status: 'ready' } }),
    rateLimited: () => false,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marks', api.createViewerMarkApi(repository, options));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); database.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const scope = (audience, subject, { permissions = { view: true, measure: true, personalMeasurements: true }, modelId = 'synthetic-model' } = {}) => {
    const token = randomUUID().replaceAll('-', '');
    const record = { audience, subject, modelId, modelVersionId: 'synthetic-v1', permissions,
      sourceAuthorization: audience === 'client' ? { type: 'direct_client_grant', id: 'grant-a', version: 1 } : null };
    sessions.set(auth.hashToken(token), record);
    return { mode: 'session', key: JSON.stringify([audience, subject, modelId]), token: () => token, record };
  };
  const requests = [];
  const mount = ({ dom = createMiniDocument(), units = () => 'imperial', request = null } = {}) => {
    const panel = dom.document.createElement('div');
    const marks = mountViewerMarks({ panel, L: {}, getMap: () => null, units,
      request: (path, init) => { requests.push([init.method, path]); return (request || fetch)(base + path, { ...init, redirect: 'follow' }); } });
    marks.setView({ map: true });
    const q = selector => panel.querySelector(selector);
    return { dom, panel, marks, store: marks.store, q,
      button: text => panel.querySelectorAll('button').find(node => node.textContent === text),
      text: () => panel.textContent,
      values: () => [...panel.querySelectorAll('input'), ...panel.querySelectorAll('textarea')].map(node => node.value).join('\n'),
      async type(selector, value) { q(selector).value = value; await q(selector).fire('input'); },
      async place(coordinates) {
        q('[name=coordinates]').value = coordinates;
        await q('[name=coordinates]').fire('input');
        await q('.viewer-mark-coords').fire('submit');
      },
      save: () => q('.viewer-mark-form').fire('submit'),
      open: name => panel.querySelectorAll('.viewer-mark-list-item').find(node => node.textContent.startsWith(name)).click(),
    };
  };
  return { mount, scope, database, requests };
}
