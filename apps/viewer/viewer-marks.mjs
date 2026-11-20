import { projectViewerMark } from './viewer-mark-position.mjs';

const coordinates = ({ latitude, longitude }) => Number.isFinite(latitude) && Math.abs(latitude) <= 90
  && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
const initialDraft = () => ({ kind: 'treeStand', color: '#ff7417', name: '', latitude: '', longitude: '', note: '' });

export function mountViewerMarks({ panel, mapLayer, request = globalThis.fetch, newId = () => crypto.randomUUID(), onMapPick = () => {} }) {
  const document = panel.ownerDocument;
  const form = panel.querySelector('form'), fields = form.elements;
  const list = panel.querySelector('[data-mark-list]'), status = panel.querySelector('[data-mark-status]');
  const placement = panel.querySelector('[data-mark-placement]'), pick = panel.querySelector('[data-mark-pick]');
  const cancel = panel.querySelector('[data-mark-cancel]'), submit = panel.querySelector('[type="submit"]');
  const window = document.defaultView;
  let context = null, view = null, marks = [], draft = initialDraft(), controller = null;
  let ready = false, busy = false, loading = false, picking = false, message = '', createId = null;
  let scopeBlocked = false;
  const listeners = new AbortController();
  const events = { signal: listeners.signal };
  const publicDrafts = () => context?.mode === 'temporary' && (marks.length || draft.name.trim() || draft.latitude !== '' || draft.longitude !== '' || draft.note.trim());
  const leave = event => {
    if (!publicDrafts()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  const readForm = () => {
    for (const field of ['kind', 'color', 'name', 'latitude', 'longitude', 'note']) draft[field] = fields.namedItem(field).value;
  };
  const writeForm = () => {
    for (const field of ['kind', 'color', 'name', 'latitude', 'longitude', 'note']) fields.namedItem(field).value = String(draft[field] ?? '');
  };
  const canPlace = mark => Boolean(view?.map && projectViewerMark(mark, view.georef)?.utm);

  function edit(mark, point = null) {
    if (!ready || busy) return;
    if (point && !canPlace(point)) { render(); return; }
    createId = null;
    draft = { ...mark, ...(point || {}) };
    writeForm();
    render();
  }

  function render() {
    panel.hidden = !context || scopeBlocked;
    if (panel.hidden) {
      mapLayer.draw([], null);
      list.replaceChildren();
      return;
    }
    status.textContent = message || (context.mode === 'temporary'
      ? 'Marks are temporary on this link and disappear when you leave.' : 'Only you can see your saved marks.');
    const supportedMap = Boolean(view?.map && view.mapFrame);
    placement.textContent = supportedMap
      ? (picking ? 'Click the map to set coordinates.' : 'Click to place a new mark, or drag an existing pin and save.')
      : view?.map ? 'Map placement needs a verified WGS84 model frame.' : '3D pin placement is unavailable without verified surface elevation.';
    pick.disabled = !ready || busy || !supportedMap;
    pick.setAttribute('aria-pressed', String(picking));
    cancel.disabled = busy;
    submit.disabled = !ready || busy;
    submit.textContent = draft.id ? 'Save changes' : 'Add mark';
    const rows = marks.map(mark => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = mark.name + (mark.kind === 'treeStand' ? ' · Tree Stand' : '');
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.textContent = 'Edit';
      editButton.disabled = busy;
      editButton.addEventListener('click', () => edit(mark));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.disabled = busy;
      remove.addEventListener('click', () => void change(mark, 'DELETE'));
      row.append(label, editButton, remove);
      return row;
    });
    list.replaceChildren(...rows);
    mapLayer.draw(ready ? marks.filter(canPlace) : [], ready && !busy ? edit : null);
  }

  async function api(path, method, body, signal, token) {
    const response = await request('/api/v1/marks' + path, {
      method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (response.status === 403) throw Object.assign(Error('Access'), { denied: true });
    if (!response.ok) throw Error('Marks request failed');
    return response.status === 204 ? null : response.json();
  }

  function reset() {
    draft = initialDraft();
    createId = null;
    picking = false;
    writeForm();
  }

  async function change(mark, method) {
    if (!context || scopeBlocked || !ready || busy) return;
    const scope = context, signal = controller.signal;
    busy = true;
    message = '';
    render();
    try {
      let saved = mark;
      if (scope.mode === 'private') {
        const token = scope.token();
        if (!token) throw Object.assign(Error('Access'), { denied: true });
        const result = await api(method === 'POST' ? '' : '/' + encodeURIComponent(mark.id), method,
          method === 'DELETE' ? { revision: mark.revision } : mark, signal, token);
        saved = result?.mark;
      }
      if (signal.aborted) return;
      if (method === 'DELETE') marks = marks.filter(row => row.id !== mark.id);
      else if (method === 'POST') {
        if (!marks.some(row => row.id === saved.id)) marks = [...marks, saved];
      } else marks = marks.map(row => row.id === saved.id ? saved : row);
      if (method !== 'DELETE' || draft.id === mark.id) reset();
    } catch (error) {
      if (signal.aborted) return;
      message = error.denied ? 'Marks are hidden until access is restored.' : 'Could not save the change. Try again.';
      if (error.denied) {
        marks = [];
        ready = false;
        reset();
      }
    } finally {
      if (!signal.aborted) {
        busy = false;
        render();
      }
    }
  }

  form.addEventListener('input', readForm, events);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!ready || busy) return;
    readForm();
    const { id, revision, kind, name, color, note } = draft;
    const mark = { id: id || (createId ||= newId()), kind, name: name.trim(), color, note: note.trim(),
      latitude: draft.latitude.trim() ? Number(draft.latitude) : NaN,
      longitude: draft.longitude.trim() ? Number(draft.longitude) : NaN };
    if (!mark.name || mark.name.length > 100 || !coordinates(mark) || note.length > 1000) {
      message = 'Enter a name and valid latitude and longitude.';
      status.textContent = message;
      return;
    }
    if (revision !== undefined) mark.revision = revision;
    void change(mark, id ? 'PUT' : 'POST');
  }, events);
  pick.addEventListener('click', () => {
    if (!ready || busy || !view?.mapFrame) return;
    picking = !picking;
    if (picking) onMapPick();
    render();
  }, events);
  cancel.addEventListener('click', () => { reset(); message = ''; render(); }, events);
  window.addEventListener('beforeunload', leave, events);

  return {
    hasTemporaryMarks() { return Boolean(publicDrafts()); },
    discardTemporaryMarks() {
      if (context?.mode !== 'temporary') return;
      marks = [];
      reset();
      render();
    },
    async setScope(next) {
      if (context?.key === next?.key && (!next || ready || loading)) {
        if (scopeBlocked) { scopeBlocked = false; render(); }
        return true;
      }
      if (context?.mode === 'temporary' && next?.mode === 'temporary' && publicDrafts()) {
        scopeBlocked = true;
        picking = false;
        render();
        return false;
      }
      scopeBlocked = false;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      context = next;
      marks = [];
      busy = false;
      message = '';
      reset();
      ready = next?.mode === 'temporary';
      loading = next?.mode === 'private';
      render();
      if (next?.mode !== 'private') return true;
      try {
        const token = next.token();
        if (!token) throw Error('No Viewer capability');
        const result = await api('', 'GET', null, signal, token);
        if (signal.aborted) return;
        marks = result.marks;
        ready = true;
      } catch {
        if (signal.aborted) return;
        message = 'Saved Marks are unavailable for this session.';
      } finally {
        if (!signal.aborted) loading = false;
      }
      if (!signal.aborted) render();
    },
    setView(next) { view = next; picking = false; render(); },
    mapClick({ lat, lng }) {
      if (scopeBlocked || !picking || !ready || busy || !canPlace({ latitude: lat, longitude: lng })) return false;
      draft.latitude = lat.toFixed(8);
      draft.longitude = lng.toFixed(8);
      picking = false;
      writeForm();
      render();
      return true;
    },
    dispose() {
      controller?.abort();
      context = null;
      listeners.abort();
      render();
    },
  };
}
