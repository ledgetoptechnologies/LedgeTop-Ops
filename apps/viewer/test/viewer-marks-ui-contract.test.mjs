import assert from 'node:assert/strict';
import test from 'node:test';
import { mountViewerMarks } from '../viewer-marks.mjs';
import { createMiniDocument } from './helpers/mini-dom.mjs';
import { createMiniLeaflet } from './helpers/mini-leaflet.mjs';

const owned = { name: 'Owned pin', color: '#1565c0', geometry: { type: 'Point', coordinates: [-87, 43] } };

test('the Marks list remains readable without advertising actions that need a map', async () => {
  const { document } = createMiniDocument();
  const panel = document.createElement('div');
  const leaflet = createMiniLeaflet(document);
  const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map });
  try {
    await marks.setScope({ mode: 'temporary', key: 'public' });
    await marks.store.create({ ...owned, id: 'pin' });
    const coords = panel.querySelector('.viewer-mark-coords');
    const list = panel.querySelector('[id=viewer-marks-list]');
    assert.equal(coords.hidden, true);
    assert.equal(list.querySelector('.viewer-mark-list-item'), null);
    assert.equal(list.querySelector('li').textContent, 'Owned pin');

    marks.setView({ map: true });
    assert.equal(coords.hidden, false);
    assert.equal(list.querySelector('.viewer-mark-list-item').tagName, 'BUTTON');
    const input = coords.querySelector('[name=coordinates]');
    input.value = '43.05, -87';
    await coords.fire('submit');
    assert.equal(panel.querySelector('.viewer-mark-form').hidden, false);
  } finally {
    marks.dispose();
  }
});

test('expired Restore keeps a draft and only brings back focus that was lost', async () => {
  for (const moveFocus of [false, true]) {
    const { document } = createMiniDocument();
    const panel = document.createElement('div');
    const leaflet = createMiniLeaflet(document);
    const row = { ...owned, id: 'deleted-pin', deletedAt: '2026-07-01T00:00:00Z', revision: 2 };
    let complete, deleted = [row];
    const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map, request: async (path, init) => {
      if (path.endsWith('/deleted')) return Response.json({ marks: deleted });
      if (init.method === 'POST') return new Promise(resolve => { complete = resolve; });
      return Response.json({ marks: [], categories: [], capabilities: { write: true, staff: true, visibility: ['private'] } });
    } });
    try {
      marks.setView({ map: true });
      await marks.setScope({ mode: 'session', key: 'staff', token: () => 'staff' });
      await panel.querySelector('.viewer-mark-layers').click();
      const deletedTab = panel.querySelector('[data-tab=deleted]');
      await deletedTab.click();
      assert.equal(marks.mapContextMenu({ lat: 43, lng: -87 }), true);
      const draft = panel.querySelector('.viewer-mark-form [name=name]');
      draft.value = 'Draft pin';
      await draft.fire('input');

      const restore = panel.querySelector('[data-restore-mark]');
      restore.focus();
      const restoring = restore.click();
      const chosen = panel.querySelector('[data-tab=categories]');
      // The miniature DOM does not automatically move focus off a removed node.
      if (moveFocus) {
        chosen.focus();
        await document.fire('focusin', { target: chosen });
      } else document.activeElement = document.body;
      deleted = [];
      complete(Response.json({ code: 'mark_not_found' }, { status: 404 }));
      await restoring;
      assert.equal(panel.querySelector('[data-restore-mark]'), null);
      assert.equal(document.activeElement, moveFocus ? chosen : deletedTab);
      assert.equal(draft.value, 'Draft pin');
      assert.equal(panel.querySelector('.viewer-mark-form').hidden, false);
    } finally {
      marks.dispose();
    }
  }
});

test('a recovered newer action remains in the Undo notice after a stale Undo click', async () => {
  const { document } = createMiniDocument();
  const panel = document.createElement('div');
  const leaflet = createMiniLeaflet(document);
  const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map });
  try {
    marks.setView({ map: true });
    await marks.setScope({ mode: 'temporary', key: 'public' });
    await marks.store.create({ ...owned, id: 'first', name: 'First pin' });
    const bar = panel.querySelector('.viewer-mark-undo'), undo = bar.querySelector('button');
    assert.match(bar.textContent, /First pin/);
    marks.store.undo = async () => {
      await marks.store.create({ ...owned, id: 'newer', name: 'Newer pin' });
      marks.store.state.failure = 'undo_target_changed';
      marks.store.state.message = 'The last change changed while Undo was checked.';
      return false;
    };
    undo.focus();
    await undo.click();
    assert.match(bar.textContent, /Newer pin.*Undo was checked/);
    assert.doesNotMatch(bar.textContent, /First pin/);
    assert.equal(document.activeElement, undo);
  } finally {
    marks.dispose();
  }
});
