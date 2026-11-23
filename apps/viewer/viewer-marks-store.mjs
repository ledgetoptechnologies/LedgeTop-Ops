// Marks state for one model: loading, saving, categories, import and a
// session undo stack. No DOM here; viewer-marks.mjs draws it.
//
// Scopes:
//   session   - a live Viewer session bearer; the server decides who may write
//   temporary - public links: marks live in this tab only and are never sent
const MARK_FIELDS = ['id', 'geometry', 'name', 'note', 'categoryId', 'color', 'icon', 'elevationNavd88M', 'visibility', 'shareAccount'];
const UNDO_LIMIT = 20;
const MESSAGES = {
  mark_revision_conflict: 'Someone else changed this mark. The list was reloaded.',
  mark_category_revision_conflict: 'Someone else changed this category. The list was reloaded.',
  mark_category_name_taken: 'A category with that name already exists.',
  mark_limit_reached: 'The mark limit for this project was reached.',
  mark_category_limit_reached: 'The category limit for this project was reached.',
  mark_rate_limited: 'Too many changes at once. Wait a minute and try again.',
  mark_edit_forbidden: 'You can only change your own marks.',
  mark_category_edit_forbidden: 'You can only change categories you made.',
  mark_identity_required: 'This login can view marks but not add them.',
  mark_share_account_unknown: 'Choose a client account to share with.',
  mark_visibility_forbidden: 'That sharing choice is not available for this mark.',
  invalid_mark: 'Check the label, colour and coordinates.',
  invalid_mark_batch: 'That file has marks the project cannot hold.',
};

class MarksError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export function createMarksStore({ request = globalThis.fetch, newId = () => crypto.randomUUID(), onChange = () => {} } = {}) {
  let context = null, controller = null;
  const state = {
    ready: false, loading: false, busy: false, blocked: false, message: '',
    marks: [], categories: [], audiences: [], capabilities: { write: false, staff: false, visibility: ['private'] }, undo: [],
  };
  const emit = () => onChange(state);
  const temporary = () => context?.mode === 'temporary';
  const find = id => state.marks.find(mark => mark.id === id) || null;

  async function api(path, method = 'GET', body, signal = controller?.signal) {
    const token = context?.token?.();
    if (!token) throw new MarksError('marks_unavailable', 403);
    const response = await request('/api/v1/marks' + path, {
      method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new MarksError(data?.code || 'marks_request_failed', response.status);
    return data;
  }

  function body(mark, extra = {}) {
    const result = {};
    for (const field of MARK_FIELDS) if (mark[field] !== undefined) result[field] = mark[field];
    if (result.categoryId && !state.categories.some(category => category.id === result.categoryId)) result.categoryId = null;
    if (result.visibility !== 'client') delete result.shareAccount;
    if (temporary()) { delete result.visibility; delete result.shareAccount; }
    return { ...result, ...extra };
  }

  function localMark(mark, previous = null) {
    const now = new Date().toISOString();
    return { ...body(mark), visibility: 'private', revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || now,
      updatedAt: now, author: 'client', mine: true, editable: true };
  }

  async function load(signal) {
    const data = await api('', 'GET', undefined, signal);
    if (signal.aborted) return;
    state.marks = data.marks;
    state.categories = data.categories;
    state.capabilities = data.capabilities;
    // Staff pick a client account when sharing a mark, if the server serves that choice.
    state.audiences = data.capabilities.staff && data.capabilities.visibility.includes('client') ? (await api('/audiences', 'GET', undefined, signal)).audiences : [];
    if (signal.aborted) return;
    state.ready = true;
  }

  // Runs one change; on failure explains it and reloads when the data moved underneath us.
  async function run(task) {
    if (!context || state.blocked || !state.ready || state.busy) return false;
    const signal = controller.signal;
    state.busy = true;
    state.message = '';
    emit();
    try {
      await task(signal);
      return !signal.aborted;
    } catch (error) {
      if (signal.aborted) return false;
      if (error.code === 'marks_unavailable') {
        state.message = 'Marks are hidden until access is restored.';
        state.marks = [];
        state.categories = [];
        state.ready = false;
        state.undo = [];
      } else {
        state.message = MESSAGES[error.code] || 'Could not save the change. Try again.';
        if (error.status === 409 || error.status === 404) await load(signal).catch(() => {});
      }
      return false;
    } finally {
      if (!signal.aborted) {
        state.busy = false;
        emit();
      }
    }
  }

  const remember = entry => { state.undo = [...state.undo, entry].slice(-UNDO_LIMIT); };

  async function createRaw(mark, signal) {
    const saved = temporary() ? localMark(mark) : (await api('', 'POST', body(mark), signal)).mark;
    if (signal.aborted) return null;
    if (!find(saved.id)) state.marks = [...state.marks, saved];
    return saved;
  }

  async function updateRaw(current, changes, signal) {
    const next = { ...current, ...changes };
    const saved = temporary() ? localMark(next, current)
      : (await api('/' + encodeURIComponent(current.id), 'PUT', body(next, { revision: current.revision }), signal)).mark;
    if (signal.aborted) return null;
    state.marks = state.marks.map(mark => (mark.id === saved.id ? saved : mark));
    return saved;
  }

  async function removeRaw(current, signal) {
    if (!temporary()) await api('/' + encodeURIComponent(current.id), 'DELETE', { revision: current.revision }, signal);
    if (signal.aborted) return;
    state.marks = state.marks.filter(mark => mark.id !== current.id);
  }

  const store = {
    state,
    canWrite: () => Boolean(context && state.ready && !state.blocked && state.capabilities.write),
    editable: mark => Boolean(store.canWrite() && mark?.editable),
    find,

    async setScope(next) {
      if (context?.key === next?.key && (!next || state.ready || state.loading)) {
        if (state.blocked) { state.blocked = false; emit(); }
        return true;
      }
      if (temporary() && next?.mode === 'temporary' && store.hasTemporaryMarks()) {
        state.blocked = true;
        emit();
        return false;
      }
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      context = next;
      Object.assign(state, { blocked: false, busy: false, message: '', marks: [], categories: [], audiences: [], undo: [],
        ready: next?.mode === 'temporary', loading: next?.mode === 'session',
        capabilities: { write: next?.mode === 'temporary', staff: false, visibility: ['private'] } });
      emit();
      if (next?.mode !== 'session') return true;
      try {
        await load(signal);
      } catch {
        if (!signal.aborted) state.message = 'Marks are unavailable for this session.';
      } finally {
        if (!signal.aborted) {
          state.loading = false;
          emit();
        }
      }
      return true;
    },

    async refresh() {
      if (temporary() || !context) return;
      await run(signal => load(signal));
    },

    async create(input) {
      const mark = { ...input, id: input.id || newId() };
      let saved = null;
      const ok = await run(async signal => {
        saved = await createRaw(mark, signal);
        if (saved) remember({ type: 'create', id: saved.id, label: 'add ' + saved.name });
      });
      return ok ? saved : null;
    },

    async update(current, changes) {
      let saved = null;
      const ok = await run(async signal => {
        saved = await updateRaw(current, changes, signal);
        if (saved) remember({ type: 'update', id: current.id, before: current, label: 'edit ' + current.name });
      });
      return ok ? saved : null;
    },

    async remove(current) {
      return run(async signal => {
        await removeRaw(current, signal);
        remember({ type: 'delete', before: current, label: 'delete ' + current.name });
      });
    },

    // Undo the last change made in this tab. A deleted mark comes back as a
    // copy with a new id (the server never reuses a deleted id).
    async undo() {
      const entry = state.undo.at(-1);
      if (!entry) return false;
      const ok = await run(async signal => {
        if (entry.type === 'create' || entry.type === 'import') {
          for (const id of entry.ids || [entry.id]) {
            const current = find(id);
            if (current) await removeRaw(current, signal);
          }
        } else if (entry.type === 'update') {
          const current = find(entry.id);
          if (!current) throw new MarksError('mark_revision_conflict', 409);
          await updateRaw(current, body(entry.before), signal);
        } else if (entry.type === 'delete') {
          await createRaw({ ...entry.before, id: temporary() ? entry.before.id : newId() }, signal);
        }
      });
      state.undo = state.undo.filter(item => item !== entry);
      emit();
      return ok;
    },

    async saveCategory(input) {
      if (temporary()) {
        const id = input.id || newId();
        const existing = state.categories.find(category => category.id === id);
        if (state.categories.some(category => category.id !== id && category.name.toLowerCase() === input.name.trim().toLowerCase())) {
          state.message = MESSAGES.mark_category_name_taken;
          emit();
          return null;
        }
        const category = { id, name: input.name.trim(), color: input.color, icon: input.icon, revision: (existing?.revision || 0) + 1, mine: true, editable: true };
        state.categories = existing ? state.categories.map(row => (row.id === id ? category : row)) : [...state.categories, category];
        state.message = '';
        emit();
        return category;
      }
      let saved = null;
      await run(async signal => {
        const payload = { id: input.id || newId(), name: input.name.trim(), color: input.color, icon: input.icon };
        saved = input.id
          ? (await api('/categories/' + encodeURIComponent(input.id), 'PUT', { ...payload, revision: input.revision }, signal)).category
          : (await api('/categories', 'POST', payload, signal)).category;
        if (signal.aborted) return;
        state.categories = [...state.categories.filter(row => row.id !== saved.id), saved]
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      });
      return saved;
    },

    async deleteCategory(category) {
      const ok = temporary() || await run(async signal => {
        await api('/categories/' + encodeURIComponent(category.id), 'DELETE', { revision: category.revision }, signal);
      });
      if (!ok) return false;
      state.categories = state.categories.filter(row => row.id !== category.id);
      state.marks = state.marks.map(mark => (mark.categoryId === category.id ? { ...mark, categoryId: null } : mark));
      emit();
      return true;
    },

    // categories: new ones the file names; marks reference their ids.
    async importMarks({ marks, categories = [] }) {
      if (!marks.length) return 0;
      let count = 0;
      const ok = await run(async signal => {
        if (temporary()) {
          state.categories = [...state.categories, ...categories.map(category => ({ ...category, revision: 1, mine: true, editable: true }))];
          const local = marks.map(mark => localMark(mark));
          state.marks = [...state.marks, ...local];
          count = local.length;
        } else {
          for (const category of categories) {
            const saved = (await api('/categories', 'POST', { id: category.id, name: category.name, color: category.color, icon: category.icon }, signal)).category;
            state.categories = [...state.categories, saved];
          }
          const saved = (await api('/batch', 'POST', { marks: marks.map(mark => body(mark)) }, signal)).marks;
          state.marks = [...state.marks, ...saved];
          count = saved.length;
        }
        remember({ type: 'import', ids: marks.map(mark => mark.id), label: `import ${count} marks` });
      });
      return ok ? count : 0;
    },

    hasTemporaryMarks: () => Boolean(temporary() && state.marks.length),
    discardTemporaryMarks() {
      if (!temporary()) return;
      state.marks = [];
      state.undo = [];
      emit();
    },
    clearMessage() { state.message = ''; },
    dispose() { controller?.abort(); context = null; },
  };
  return store;
}
