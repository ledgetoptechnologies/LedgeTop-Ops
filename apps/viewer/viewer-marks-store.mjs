import { STARTER_CATEGORIES } from './viewer-mark-style.mjs';

// Marks state for one model: loading, saving, categories, import and a
// session undo stack. No DOM here; viewer-marks.mjs draws it.
//
// Scopes:
//   session   - a live Viewer session bearer; the server decides who may write
//   temporary - public links: marks live in this tab only and are never sent
const MARK_FIELDS = ['id', 'geometry', 'name', 'note', 'categoryId', 'color', 'icon', 'elevationNavd88M', 'visibility', 'shareAccount'];
const UNDO_LIMIT = 20;
// What others share arrives in pages; this many are shown at most.
const SHARED_LIMIT = 5000;
const MESSAGES = {
  mark_revision_conflict: 'Someone else changed this mark. The list was reloaded.',
  mark_category_revision_conflict: 'Someone else changed this category. The list was reloaded.',
  mark_category_name_taken: 'A category with that name already exists.',
  mark_limit_reached: 'The mark limit for this project was reached.',
  mark_category_limit_reached: 'The category limit for this project was reached.',
  mark_rate_limited: 'Too many requests at once. Wait a minute and try again.',
  mark_storage_limit: 'Your marks take up all the space there is for them here. Delete or simplify some first.',
  mark_deleted_full: 'Recently deleted is full, so this one could not be brought back. Nothing was deleted.',
  mark_category_not_found: 'That category is gone. The list was reloaded.',
  import_changed: 'Some of those marks changed since the import, so it was not undone.',
  import_too_large: 'That file is too large to import at once. Split it and import the parts.',
  'entity.too.large': 'That is too large to save at once.',
  mark_edit_forbidden: 'You can only change your own marks.',
  mark_category_edit_forbidden: 'You can only change categories you made.',
  mark_identity_required: 'This login cannot keep marks.',
  mark_share_account_unknown: 'Choose a client account to share with.',
  mark_visibility_forbidden: 'That sharing choice is not available for this mark.',
  invalid_mark: 'Check the label, colour and coordinates.',
  invalid_mark_batch: 'That file has marks the project cannot hold.',
};

class MarksError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
// Thrown into a continuation whose scope was replaced; run() drops it silently.
class ScopeEnded extends Error {}

export function createMarksStore({ request = globalThis.fetch, newId = () => crypto.randomUUID(), onChange = () => {} } = {}) {
  let context = null, controller = null;
  const state = {
    ready: false, loading: false, busy: false, blocked: false, message: '',
    marks: [], categories: [], audiences: [], deleted: [], starters: [], capabilities: { write: false, staff: false, visibility: ['private'] }, undo: [],
    // Why the last change failed, for the panel to offer what is possible instead.
    failure: '',
  };
  const emit = () => onChange(state);
  const temporary = () => context?.mode === 'temporary';
  const find = id => state.marks.find(mark => mark.id === id) || null;

  // One owner's view of the store. Every change holds the scope it started in:
  // requests use that scope's token and signal, and check() ends a continuation
  // that resumes after the scope was replaced, before it can touch state.
  function currentScope() {
    const held = context, { signal } = controller;
    const live = () => !signal.aborted;
    const check = () => { if (signal.aborted) throw new ScopeEnded(); };
    return {
      live, check, temporary: held?.mode === 'temporary',
      async api(path, method = 'GET', body) {
        check();
        const token = held?.token?.();
        if (!token) throw new MarksError('marks_unavailable', 403);
        const response = await request('/api/v1/marks' + path, {
          method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
          headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) },
          ...(body && { body: JSON.stringify(body) }),
        });
        check();
        if (response.status === 204) return null;
        const data = await response.json().catch(() => null);
        check();
        if (!response.ok) throw new MarksError(data?.code || 'marks_request_failed', response.status);
        return data;
      },
    };
  }

  function body(mark, extra = {}) {
    const result = {};
    for (const field of MARK_FIELDS) if (mark[field] !== undefined) result[field] = mark[field];
    if (result.visibility !== 'client') delete result.shareAccount;
    if (temporary()) { delete result.visibility; delete result.shareAccount; }
    return { ...result, ...extra };
  }

  function localMark(mark, previous = null) {
    const now = new Date().toISOString();
    return { ...body(mark), visibility: 'private', revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || now,
      updatedAt: now, author: 'client', mine: true, editable: true };
  }

  async function load(scope) {
    const data = await scope.api('');
    scope.check();
    // Staff pick a client account when sharing a mark, if the server serves that choice.
    const audiences = data.capabilities.staff && data.capabilities.visibility.includes('client') ? (await scope.api('/audiences')).audiences : [];
    scope.check();
    if (!data.capabilities.write) Object.assign(state, { undo: [], deleted: [] });
    const first = !state.ready;
    if (first || !data.capabilities.shared) Object.assign(state, { marks: data.marks, categories: data.categories, starters: data.starters || [], capabilities: data.capabilities, audiences, ready: true });
    if (!data.capabilities.shared) return;
    // The first time, marks appear as they arrive. Later what is on screen stays
    // until everything new is here.
    let marks = first ? null : [...data.marks], categories = first ? null : [...data.categories], count = 0, next = null;
    try {
      do {
        const page = await scope.api('/shared' + (next ? '?after=' + encodeURIComponent(next) : ''));
        scope.check();
        const add = (list, items) => [...list, ...items.filter(item => !list.some(row => row.id === item.id))];
        if (first) {
          const have = new Set(state.marks.map(mark => mark.id));
          state.marks = [...state.marks, ...page.marks.filter(mark => !have.has(mark.id))];
          state.categories = byName(add(state.categories, page.categories));
          emit();
        } else {
          marks.push(...page.marks);
          categories = add(categories, page.categories);
        }
        count += page.marks.length;
        next = page.next;
      } while (next && count < SHARED_LIMIT);
      if (next) state.message ||= `Only the first ${count} marks shared with you are shown.`;
    } catch (error) {
      scope.check();
      if (error.code === 'marks_unavailable' || error.code === 'mark_identity_required') throw error;
      state.message ||= 'Some shared marks could not be loaded. Reload the page to try again.';
    }
    if (!first) {
      // If part of a reload failed, what is shown is the person's own and what this
      // reload read. Anything older may have been withdrawn by its owner meanwhile.
      Object.assign(state, { marks, categories: byName(categories), starters: data.starters || [], capabilities: data.capabilities, audiences, ready: true });
    }
  }

  // Runs one change; on failure explains it and reloads when the data moved underneath us.
  async function run(task) {
    if (!context || state.blocked || !state.ready || state.busy) return false;
    const scope = currentScope();
    state.busy = true;
    state.message = '';
    state.failure = '';
    emit();
    try {
      await task(scope);
      return scope.live();
    } catch (error) {
      if (!scope.live()) return false;
      state.failure = error.code || 'failed';
      if (error.code === 'marks_unavailable') {
        state.message = 'Marks are hidden until access is restored.';
        state.marks = [];
        state.categories = [];
        state.deleted = [];
        state.starters = [];
        state.ready = false;
        state.undo = [];
      } else {
        state.message = MESSAGES[error.code] || 'Could not save the change. Try again.';
        if (error.status === 409 || error.status === 404 || ['mark_identity_required', 'mark_category_not_found'].includes(error.code)) await load(scope).catch(() => {});
      }
      return false;
    } finally {
      if (scope.live()) {
        state.busy = false;
        emit();
      }
    }
  }

  const byName = list => [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  // Someone who begins with their own category is not offered the starters.
  const beganOwn = () => { if (state.starters.length === STARTER_CATEGORIES.length) state.starters = []; };
  const remember = entry => { state.undo = [...state.undo, entry].slice(-UNDO_LIMIT); };

  async function createRaw(mark, scope) {
    const saved = scope.temporary ? localMark(mark) : (await scope.api('', 'POST', body(mark))).mark;
    scope.check();
    if (!find(saved.id)) state.marks = [...state.marks, saved];
    return saved;
  }

  async function updateRaw(current, changes, scope) {
    const next = { ...current, ...changes };
    const saved = scope.temporary ? localMark(next, current)
      : (await scope.api('/' + encodeURIComponent(current.id), 'PUT', body(next, { revision: current.revision }))).mark;
    scope.check();
    state.marks = state.marks.map(mark => (mark.id === saved.id ? saved : mark));
    return saved;
  }

  async function removeRaw(current, scope, { permanent = false } = {}) {
    if (!scope.temporary) await scope.api('/' + encodeURIComponent(current.id), 'DELETE', { revision: current.revision, ...(permanent && { permanent }) });
    scope.check();
    state.marks = state.marks.filter(mark => mark.id !== current.id);
  }

  // Back from the server's deleted list, with the id it had.
  async function restoreRaw(deleted, scope) {
    const { mark } = await scope.api('/' + encodeURIComponent(deleted.id) + '/restore', 'POST', { revision: deleted.revision });
    scope.check();
    if (!find(mark.id)) state.marks = [...state.marks, mark];
    state.deleted = state.deleted.filter(item => item.id !== mark.id);
    return mark;
  }

  const store = {
    state,
    canWrite: () => Boolean(context && state.ready && !state.blocked && state.capabilities.write),
    editable: mark => Boolean(store.canWrite() && mark?.editable),
    find,
    // For work that waits before it calls the store (reading a file): live()
    // turns false once the scope it started in is replaced.
    hold() { const scope = context ? currentScope() : null; return { live: () => Boolean(scope?.live()) }; },

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
      context = next;
      const scope = currentScope();
      Object.assign(state, { blocked: false, busy: false, message: '', marks: [], categories: [], audiences: [], deleted: [], undo: [],
        starters: next?.mode === 'temporary' ? STARTER_CATEGORIES.map(starter => starter.key) : [],
        ready: next?.mode === 'temporary', loading: next?.mode === 'session',
        capabilities: { write: next?.mode === 'temporary', staff: false, visibility: ['private'] } });
      emit();
      if (next?.mode !== 'session') return true;
      try {
        await load(scope);
      } catch {
        if (scope.live()) state.message = 'Marks are unavailable for this session.';
      } finally {
        if (scope.live()) {
          state.loading = false;
          emit();
        }
      }
      return true;
    },

    async refresh() {
      if (temporary() || !context) return;
      await run(scope => load(scope));
    },

    async create(input) {
      const mark = { ...input, id: input.id || newId() };
      let saved = null;
      const ok = await run(async scope => {
        saved = await createRaw(mark, scope);
        scope.check();
        remember({ type: 'create', id: saved.id, label: 'add ' + saved.name });
      });
      return ok ? saved : null;
    },

    async update(current, changes) {
      if (!find(current?.id)) return null;
      let saved = null;
      const ok = await run(async scope => {
        saved = await updateRaw(current, changes, scope);
        scope.check();
        remember({ type: 'update', id: current.id, before: current, label: 'edit ' + current.name });
      });
      return ok ? saved : null;
    },

    // permanent: the person said for good, so there is nothing to undo.
    async remove(current, { permanent = false } = {}) {
      if (!find(current?.id)) return false;
      return run(async scope => {
        await removeRaw(current, scope, { permanent });
        scope.check();
        if (!permanent) remember({ type: 'delete', before: current, label: 'delete ' + current.name });
      });
    },

    // The owner's own recently deleted marks, read when asked for.
    async loadDeleted() {
      if (!context || temporary()) return false;
      return run(async scope => {
        const { marks } = await scope.api('/deleted');
        scope.check();
        state.deleted = marks;
      });
    },
    async restore(deleted) {
      if (!state.deleted.some(item => item.id === deleted?.id)) return null;
      let saved = null;
      const ok = await run(async scope => {
        saved = await restoreRaw(deleted, scope);
        scope.check();
        remember({ type: 'create', id: saved.id, label: 'restore ' + saved.name });
      });
      return ok ? saved : null;
    },

    // Undo the last change made in this tab.
    async undo() {
      const entry = state.undo.at(-1);
      if (!entry) return false;
      const held = store.hold();
      const ok = await run(async scope => {
        if (entry.type === 'create') {
          const current = find(entry.id);
          if (current) await removeRaw(current, scope);
        } else if (entry.type === 'import') {
          // Exactly what the import returned, in one request: all of it as it was, or nothing.
          if (scope.temporary) {
            if (entry.marks.some(mark => find(mark.id)?.revision !== mark.revision)) throw new MarksError('import_changed', 409);
          } else {
            try { await scope.api('/batch/delete', 'POST', { marks: entry.marks }); }
            catch (error) { throw ['mark_revision_conflict', 'mark_not_found', 'mark_edit_forbidden'].includes(error.code) ? new MarksError('import_changed', 409) : error; }
          }
          scope.check();
          const ids = new Set(entry.marks.map(mark => mark.id));
          state.marks = state.marks.filter(mark => !ids.has(mark.id));
        } else if (entry.type === 'update') {
          const current = find(entry.id);
          if (!current) throw new MarksError('mark_revision_conflict', 409);
          await updateRaw(current, body(entry.before), scope);
        } else if (entry.type === 'delete') {
          if (scope.temporary) await createRaw(entry.before, scope);
          else await restoreRaw(entry.before, scope);
        }
      });
      if (!held.live()) return false;
      // A change that has moved underneath can never be undone; anything else can be tried again.
      const gone = ['mark_revision_conflict', 'mark_not_found', 'mark_edit_forbidden', 'mark_category_not_found', 'import_changed'].includes(state.failure);
      if (ok || gone) state.undo = state.undo.filter(item => item !== entry);
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
        if (!existing) beganOwn();
        const category = { id, name: input.name.trim(), color: input.color, icon: input.icon, revision: (existing?.revision || 0) + 1, mine: true, editable: true };
        state.categories = existing ? state.categories.map(row => (row.id === id ? category : row)) : [...state.categories, category];
        state.message = '';
        emit();
        return category;
      }
      let saved = null;
      const ok = await run(async scope => {
        const payload = { id: input.id || newId(), name: input.name.trim(), color: input.color, icon: input.icon };
        saved = input.id
          ? (await scope.api('/categories/' + encodeURIComponent(input.id), 'PUT', { ...payload, revision: input.revision })).category
          : (await scope.api('/categories', 'POST', payload)).category;
        scope.check();
        if (!input.id) beganOwn();
        state.categories = [...state.categories.filter(row => row.id !== saved.id), saved]
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      });
      return ok ? saved : null;
    },

    async deleteCategory(category) {
      const held = store.hold();
      const ok = temporary() || await run(async scope => {
        await scope.api('/categories/' + encodeURIComponent(category.id), 'DELETE', { revision: category.revision });
      });
      if (!ok || !held.live()) return false;
      state.categories = state.categories.filter(row => row.id !== category.id);
      const without = mark => (mark?.categoryId === category.id ? { ...mark, categoryId: null } : mark);
      state.marks = state.marks.map(without);
      state.undo = state.undo.map(item => (item.before ? { ...item, before: without(item.before) } : item));
      emit();
      return true;
    },

    starters: () => STARTER_CATEGORIES.filter(starter => state.starters.includes(starter.key)),
    // Makes a starter category (or finds the one this person already has) and returns it.
    async addStarter(starter) {
      if (!store.starters().includes(starter)) return null;
      const { key, name, color, icon } = starter;
      let saved = null;
      const ok = await run(async scope => {
        saved = scope.temporary ? { id: newId(), name, color, icon, revision: 1, mine: true, editable: true }
          : (await scope.api('/categories/starter', 'POST', { key, name, color, icon })).category;
        scope.check();
        state.categories = [...state.categories.filter(row => row.id !== saved.id), saved]
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        state.starters = state.starters.filter(item => item !== key);
      });
      return ok ? saved : null;
    },

    // categories: new ones the file names; marks reference their ids.
    async importMarks({ marks, categories = [] }) {
      if (!marks.length) return 0;
      let count = 0;
      const ok = await run(async scope => {
        let imported;
        if (scope.temporary) {
          if (categories.length) beganOwn();
          state.categories = [...state.categories, ...categories.map(category => ({ ...category, revision: 1, mine: true, editable: true }))];
          const local = marks.map(mark => localMark(mark));
          state.marks = [...state.marks, ...local];
          imported = local;
        } else {
          const payload = { marks: marks.map(mark => body(mark)),
            categories: categories.map(({ id, name, color, icon }) => ({ id, name, color, icon })) };
          const limit = state.capabilities.maxRequestBytes;
          if (limit && new TextEncoder().encode(JSON.stringify(payload)).length > limit) throw new MarksError('import_too_large', 413);
          const saved = await scope.api('/batch', 'POST', payload);
          scope.check();
          state.marks = [...state.marks, ...saved.marks];
          if (saved.categories.length) beganOwn();
          state.categories = byName([...state.categories, ...saved.categories.filter(row => !state.categories.some(item => item.id === row.id))]);
          imported = saved.marks;
        }
        count = imported.length;
        remember({ type: 'import', marks: Object.freeze(imported.map(({ id, revision }) => Object.freeze({ id, revision }))), label: `import ${count} marks` });
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
