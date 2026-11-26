import { markContent, sameMark, SENT_LIMIT, sentBefore } from './viewer-mark-draft-recovery.mjs';
import { STARTER_CATEGORIES } from './viewer-mark-style.mjs';

// Marks state for one model: loading, saving, categories, import and a
// session undo stack. No DOM here; viewer-marks.mjs draws it.
//
// Scopes:
//   session   - a live Viewer session bearer; the server decides who may write
//   temporary - public links: marks live in this tab only and are never sent. With a
//               token, what staff share is read too, if the link shows it
const MARK_FIELDS = ['id', 'geometry', 'name', 'note', 'categoryId', 'color', 'icon', 'elevationNavd88M', 'visibility', 'shareAccount', 'access'];
const UNDO_LIMIT = 20;
// What others share arrives in pages; this many are shown at most.
const SHARED_LIMIT = 5000;
// And this many pages at most, as a page may be empty.
const PAGE_LIMIT = 100;
// How long an answer is waited for before a change counts as not answered (a large one
// longer, by its size), and for the check whether it was made.
export const WRITE_MS = 30_000;
export const READ_MS = 30_000;
const BYTES_PER_MS = 8;
const MESSAGES = {
  mark_revision_conflict: 'Someone else changed this mark. The list was reloaded.',
  mark_category_revision_conflict: 'Someone else changed this category. The list was reloaded.',
  mark_category_name_taken: 'A category with that name already exists.',
  mark_category_id_conflict: 'That category changed or is no longer available.',
  mark_limit_reached: 'The mark limit for this project was reached.',
  mark_category_limit_reached: 'The category limit for this project was reached.',
  mark_rate_limited: 'Too many requests at once. Wait a minute and try again.',
  mark_storage_limit: 'Your marks take up all the space there is for them here. Delete or simplify some first.',
  mark_deleted_full: 'Recently deleted is full, so this one could not be brought back. Nothing was deleted.',
  mark_category_not_found: 'That category is gone. The list was reloaded.',
  answer_unknown: 'No answer came, so this may or may not be saved. Try again to check.',
  mark_id_conflict: 'Someone else changed this mark. The list was reloaded.',
  mark_gone: 'That mark is no longer there. The list was reloaded.',
  restore_unavailable: 'That mark is no longer available to restore.',
  still_recoverable: 'It is in Recently deleted, not deleted for good.',
  undo_moved: 'That mark changed since, so this was not undone.',
  undo_target_changed: 'A change was recovered. Review the action and choose Undo again.',
  undo_unclear: 'Some of those marks changed meanwhile. The list was reloaded.',
  import_unsure: 'The import was saved, but part of it changed since, so it cannot be undone.',
  saved_after_all: 'The change before this one was saved after all. Try again for this one.',
  import_changed: 'Some of those marks changed since the import, so it was not undone.',
  import_too_large: 'That file is too large to import at once. Split it and import the parts.',
  'entity.too.large': 'That is too large to save at once.',
  mark_edit_forbidden: 'You can only change your own marks.',
  mark_version_not_found: 'There is no earlier version to go back to.',
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
// A look-up that answered, but does not say.
const UNKNOWN = Symbol('unknown');
// Thrown into a continuation whose scope was replaced; run() drops it silently.
class ScopeEnded extends Error {}
const viewerAccessLost = error => error.code !== 'mark_identity_required' && (error.status === 401
  || error.code === 'marks_unavailable' || (error.code === 'marks_request_failed' && error.status === 403));
const accessLost = error => error.code === 'mark_identity_required' || viewerAccessLost(error);

export function createMarksStore({ request = globalThis.fetch, newId = () => crypto.randomUUID(), onChange = () => {}, onViewerAccessLost = () => {},
  later = (work, ms) => { const id = globalThis.setTimeout(work, ms); return () => globalThis.clearTimeout(id); } } = {}) {
  let context = null, controller = null, sharedRefresh = null;
  // The notice that the shared list was cut short, while it is the one shown.
  let cutShort = null;
  // Changes not answered, by mark: what was sent and what it was based on. And the one
  // that could not be checked either, if any: nothing else is sent before it is.
  let attempts = new Map(), doubt = null;
  const pendingImports = new Map();
  // A refusal applies only to the bearer that got it. A renewed session can
  // keep the same owner key, and replacing that key is not required to retry.
  const refusalBearers = new WeakMap();
  const state = {
    ready: false, loading: false, busy: false, blocked: false, message: '',
    marks: [], categories: [], audiences: [], deleted: [], deletedTruncated: false, starters: [], capabilities: { write: false, staff: false, visibility: ['private'] }, undo: [],
    // Why the last change failed, for the panel to offer what is possible instead.
    failure: '', recoveredChange: null,
  };
  const emit = () => onChange(state);
  const temporary = () => context?.mode === 'temporary';
  const find = id => state.marks.find(mark => mark.id === id) || null;
  const bearer = () => context?.token?.();
  const staleRefusal = error => refusalBearers.has(error) && refusalBearers.get(error) !== bearer();
  const readOnlyCapabilities = () => ({ write: false, staff: false, visibility: ['private'] });

  function hideInaccessibleMarks(error, message = 'Marks are hidden until access is restored.') {
    Object.assign(state, {
      ready: false, marks: [], categories: [], audiences: [], deleted: [], deletedTruncated: false, starters: [], undo: [],
      capabilities: readOnlyCapabilities(), recoveredChange: null, failure: error.code,
      message,
    });
    if (viewerAccessLost(error)) onViewerAccessLost();
  }

  // One owner's view of the store. Every change holds the scope it started in:
  // requests use that scope's token and signal, and check() ends a continuation
  // that resumes after the scope was replaced, before it can touch state.
  function currentScope(signal = controller.signal) {
    const held = context;
    const live = () => !signal.aborted;
    const check = () => { if (signal.aborted) throw new ScopeEnded(); };
    return {
      live, check, temporary: held?.mode === 'temporary',
      async api(path, method = 'GET', body, { readOnly = method === 'GET' } = {}) {
        check();
        const token = bearer();
        const text = body && JSON.stringify(body);
        // Reading the list at the start may take its time; nothing waits for it.
        const limit = readOnly ? (state.busy ? READ_MS : 0) : Math.max(WRITE_MS, (text?.length || 0) / BYTES_PER_MS);
        try {
          if (!token) throw new MarksError('marks_unavailable', 403);
          return await bounded(limit, signal, own => answer(path, method, token, text, own, check));
        } catch (error) {
          check();
          if (accessLost(error)) refusalBearers.set(error, token);
          if (!readOnly && !(error instanceof MarksError && error.status < 500)) throw new MarksError('answer_unknown', 0);
          throw error;
        }
      },
    };
  }

  // Ends by itself after limit, or with the scope, also when the request does neither.
  function bounded(limit, signal, work) {
    const own = new AbortController(), stop = () => own.abort();
    signal.addEventListener('abort', stop, { once: true });
    const cancel = limit ? later(stop, limit) : null;
    const ended = new Promise((_, reject) => own.signal.addEventListener('abort', () => reject(new Error('ended')), { once: true }));
    return Promise.race([work(own.signal), ended]).finally(() => { cancel?.(); signal.removeEventListener('abort', stop); });
  }

  async function answer(path, method, token, text, signal, check) {
    const response = await request('/api/v1/marks' + path, {
      method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
      headers: { authorization: 'Bearer ' + token, ...(text && { 'content-type': 'application/json' }) },
      ...(text && { body: text }),
    });
    check();
    if (response.status === 204) return null;
    const data = await response.json().catch(() => null);
    check();
    if (!response.ok) throw new MarksError(data?.code || 'marks_request_failed', response.status);
    // Cut off on the way: what was asked for may well have been done.
    if (data === null) throw new Error('no answer');
    return data;
  }

  function body(mark, extra = {}) {
    const result = {};
    for (const field of MARK_FIELDS) if (mark[field] !== undefined) result[field] = mark[field];
    if (result.visibility !== 'client') delete result.shareAccount;
    if (result.visibility !== 'shared') delete result.access;
    if (temporary()) { delete result.visibility; delete result.shareAccount; delete result.access; }
    return { ...result, ...extra };
  }

  function localMark(mark, previous = null) {
    const now = new Date().toISOString();
    return { ...body(mark), visibility: 'private', revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || now,
      updatedAt: now, author: 'client', mine: true, editable: true };
  }

  // Reads a list a page at a time: at most PAGE_LIMIT requests and SHARED_LIMIT rows. A page
  // may be empty and still move on (rows are left out after being counted), so only the end
  // (no cursor) is the whole list; a cursor already read from, or a limit reached while there
  // is more, makes it truncated.
  async function readPages(scope, path, receive) {
    let count = 0, requests = 0, next = null, truncated = false;
    const seen = new Set();
    for (;;) {
      const page = await scope.api(path + (next ? '?after=' + encodeURIComponent(next) : ''));
      requests += 1;
      scope.check();
      if (!Array.isArray(page?.marks)) throw new Error('Incomplete marks page');
      const marks = page.marks.slice(0, SHARED_LIMIT - count);
      receive({ ...page, marks });
      count += marks.length;
      // Rows left out for the row limit: cut short, whatever the cursor says.
      if (marks.length < page.marks.length) { truncated = true; break; }
      if (!page.next) break;
      if (seen.has(page.next) || count >= SHARED_LIMIT || requests >= PAGE_LIMIT) { truncated = true; break; }
      seen.add(page.next);
      next = page.next;
    }
    return { count, truncated };
  }

  const readSharedPages = (scope, receive) => readPages(scope, '/shared', page => {
    if (!Array.isArray(page.categories)) throw new Error('Incomplete shared marks page');
    receive(page);
  });

  function addUnseen(list, records) {
    const ids = new Set(list.map(item => item.id));
    return [...list, ...records.filter(item => !ids.has(item.id))];
  }

  async function load(scope) {
    try { await loadSnapshot(scope); }
    catch (error) {
      scope.check();
      if (!staleRefusal(error)) throw error;
      await loadSnapshot(scope);
    }
  }

  async function loadSnapshot(scope) {
    const data = await scope.api('');
    scope.check();
    // Staff pick a client account when sharing a mark, if the server serves that choice.
    const audiences = data.capabilities.staff && data.capabilities.visibility.includes('client') ? (await scope.api('/audiences')).audiences : [];
    scope.check();
    if (!data.capabilities.write) Object.assign(state, { undo: [], deleted: [], deletedTruncated: false });
    const first = !state.ready;
    if (first || !data.capabilities.shared) Object.assign(state, { marks: data.marks, categories: data.categories, starters: data.starters || [], capabilities: data.capabilities, audiences, ready: true });
    if (!data.capabilities.shared) return;
    // The first time, marks appear as they arrive. Later what is on screen stays
    // until everything new is here.
    let marks = first ? null : [...data.marks], categories = first ? null : [...data.categories];
    try {
      const { count, truncated } = await readSharedPages(scope, page => {
        if (first) {
          state.marks = addUnseen(state.marks, page.marks);
          state.categories = byName(addUnseen(state.categories, page.categories));
          emit();
        } else {
          marks.push(...page.marks);
          categories = addUnseen(categories, page.categories);
        }
      });
      if (truncated && !state.message) state.message = cutShort = `Only the first ${count} marks shared with you are shown.`;
    } catch (error) {
      scope.check();
      if (accessLost(error)) throw error;
      state.message ||= 'Some shared marks could not be loaded. Reload the page to try again.';
    }
    if (!first) {
      // If part of a reload failed, what is shown is the person's own and what this
      // reload read. Anything older may have been withdrawn by its owner meanwhile.
      Object.assign(state, { marks, categories: byName(categories), starters: data.starters || [], capabilities: data.capabilities, audiences, ready: true });
    }
  }

  function cancelSharedRefresh() {
    sharedRefresh?.abort();
    sharedRefresh = null;
  }

  // Activity in this tab may write independent marks while this read is in flight.
  // As on a full reload, a confirmed prefix replaces the previous shared rows
  // so a failure on a later page cannot keep rows that may have been withdrawn.
  async function refreshShared() {
    if (context?.mode !== 'session' || !state.ready || !state.capabilities.shared
      || state.loading || state.busy || state.blocked || sharedRefresh) return;
    const refresh = new AbortController();
    sharedRefresh = refresh;
    const scope = currentScope(refresh.signal);
    const token = bearer();
    let timedOut = false, current = false;
    const stopTimeout = later(() => { timedOut = true; refresh.abort(); }, READ_MS);
    const marks = [], categories = new Map();
    let received = false, partial = false, refusal = null, truncated = false;
    try {
      ({ truncated } = await readSharedPages(scope, page => {
        received = true;
        marks.push(...page.marks);
        for (const category of page.categories) categories.set(category.id, category);
      }));
    } catch (error) {
      if (!scope.live() && !timedOut) return;
      if (accessLost(error)) refusal = error;
      else if (received) partial = true;
      else return;
    } finally {
      stopTimeout();
      current = sharedRefresh === refresh;
      if (current) sharedRefresh = null;
    }
    if (!current || bearer() !== token || (refusal && staleRefusal(refusal))) return;
    if (refusal) {
      hideInaccessibleMarks(refusal);
      emit();
      return;
    }
    const nextMarks = addUnseen(state.marks.filter(mark => mark.mine), marks);
    const nextCategories = byName(addUnseen(state.categories.filter(category => category.mine), [...categories.values()]));
    // A whole refresh takes back the notice that the list was cut short, and nothing else.
    const cleared = !partial && !truncated && cutShort !== null && state.message === cutShort;
    if (cleared) state.message = '';
    if (state.message !== cutShort) cutShort = null;
    const notice = cleared || ((partial || truncated) && !state.message);
    if (notice && !cleared) {
      if (partial) state.message = 'Some shared marks could not be loaded. Reload the page to try again.';
      else state.message = cutShort = `Only the first ${marks.length} marks shared with you are shown.`;
    }
    if (!notice && JSON.stringify(nextMarks) === JSON.stringify(state.marks)
      && JSON.stringify(nextCategories) === JSON.stringify(state.categories)) return;
    Object.assign(state, { marks: nextMarks, categories: nextCategories });
    emit();
  }

  const attempted = (id, revision, mark) => attempts.set(id, [...(attempts.get(id) || []), { revision, ...markContent(mark) }].slice(-SENT_LIMIT));
  // Whether what is there now came from here, although it was never answered.
  const own = id => sentBefore(find(id), attempts.get(id));
  // What a change is based on: what the person saw, or their own change since.
  const based = current => (own(current.id) ? find(current.id) : current);

  // Was it made? If that cannot be found out either, it stays in doubt.
  async function checkDoubt(scope, op, { read = true } = {}) {
    try {
      if (read) await load(scope);
      scope.check();
      await op.look?.(scope);
    } catch (error) {
      scope.check();
      if (accessLost(error)) throw error;
      doubt = op;
      throw new MarksError('answer_unknown', 0);
    }
    scope.check();
    const value = op.landed?.();
    doubt = value === UNKNOWN ? op : null;
    if (doubt) throw new MarksError('answer_unknown', 0);
    return value;
  }

  // What was in doubt is settled before anything else is sent.
  async function settleDoubt(scope, op) {
    const earlier = doubt, again = op.key && op.key === earlier.key;
    doubt = null;
    const value = await checkDoubt(scope, again ? op : earlier);
    if (again || value === undefined) return again ? value : undefined;
    earlier.done?.(value, false);
    // Perhaps this was meant as the same thing again: the person sees it before more is added.
    if (op.makes) throw new MarksError('saved_after_all', 0);
    return undefined;
  }

  // Where a mark that is no longer in the list went, by the owner's own lists. Not being
  // there says nothing by itself.
  function departure(id, revision) {
    let row = null, none = false, looked = false;
    return {
      async look(scope) {
        const marks = await readDeletedRows(scope);
        row = marks.find(mark => mark.id === id) || null;
        none = false;
        if (!find(id) && !row) {
          try { await scope.api('/' + encodeURIComponent(id)); }
          catch (error) {
            scope.check();
            if (error.code !== 'mark_not_found') throw error;
            none = true;
          }
        }
        looked = true;
      },
      // there, deleted (at the version expected), deleted later, or gone for good
      where() {
        if (find(id)) return 'there';
        if (!looked || !state.capabilities.write) return UNKNOWN;
        if (row) return row.revision === revision() ? 'deleted' : 'later';
        return none ? 'gone' : 'there';
      },
    };
  }

  // Undo entries made of the version before an undone change are now about this one.
  function follow(id, from, to) {
    state.undo = state.undo.map(entry => (entry.id === id && entry.revision === from ? { ...entry, revision: to } : entry));
  }

  // Runs one change; on failure explains it and reloads when the data moved underneath us.
  // A change without an answer is looked up: found, it counts as made. op says how:
  //   landed() what the change made, if it is there now, or that this does not say
  //   look(scope) reads what else that takes    done(value, answered) once, when it was made
  // Found without an answer, it is as wanted, but may be another tab's: then no Undo, which
  // would take theirs back. A new id is only ever one's own.
  //   tried() it went out unanswered    mine() what is in its way is itself, from before
  //   key the same for a second go at it    makes it adds something each time it is sent
  async function run(send, op = {}) {
    if (!context || state.blocked || !state.ready || state.busy) return false;
    cancelSharedRefresh();
    const scope = currentScope();
    state.busy = true;
    state.message = '';
    state.failure = '';
    emit();
    try {
      let value = doubt ? await settleDoubt(scope, op) : undefined, answered = false;
      for (let again = false; value === undefined; again = true) {
        try { value = (await send(scope)) ?? true; answered = true; }
        catch (error) {
          scope.check();
          if (error.code === 'answer_unknown') {
            op.tried?.();
            value = await checkDoubt(scope, op);
            if (value === undefined) throw new MarksError('not_saved', 0);
          } else if (!scope.temporary && !again && op.mine && ([404, 409].includes(error.status)
            || (op.refused && error.status === 400 && error.code === 'mark_category_not_found'))) {
            error.loaded = true;
            try { await load(scope); }
            catch (readError) {
              scope.check();
              if (accessLost(readError)) throw readError;
              // The old list cannot say whether the request already succeeded.
              throw error;
            }
            scope.check();
            if (!op.mine()) {
              await op.refused?.(scope, error);
              throw error;
            }
            // By the same evidence: not being in the list says nothing by itself.
            value = await checkDoubt(scope, op, { read: false });
          } else throw error;
        }
      }
      scope.check();
      // Only an answer or evidence gets here.
      if (value === UNKNOWN) throw new MarksError('answer_unknown', 0);
      op.done?.(value, answered);
      return scope.live();
    } catch (error) {
      if (!scope.live() || staleRefusal(error)) return false;
      state.failure = error.code || 'failed';
      if (accessLost(error)) {
        hideInaccessibleMarks(error);
      } else {
        state.message = MESSAGES[error.code] || 'Could not save the change. Try again.';
        // Temporary marks live only in this tab. A local conflict needs no signed reload.
        if (!scope.temporary && !error.loaded
          && (error.status === 409 || error.status === 404 || error.code === 'mark_category_not_found')) {
          await load(scope).catch(readError => {
            if (scope.live() && accessLost(readError) && !staleRefusal(readError)) hideInaccessibleMarks(readError);
          });
        }
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
  // at: the order changes were made in, so the newest can be told from one gone back to.
  let changes = 0;
  const remember = entry => { state.undo = [...state.undo, { ...entry, at: changes += 1 }].slice(-UNDO_LIMIT); };
  const noteRecovered = done => { state.recoveredChange = { done, at: changes += 1 }; };

  async function createRaw(mark, scope) {
    const saved = scope.temporary ? localMark(mark) : (await scope.api('', 'POST', body(mark))).mark;
    scope.check();
    if (!find(saved.id)) state.marks = [...state.marks, saved];
    // It had arrived before and was changed by someone since.
    if (saved.revision !== 1) throw new MarksError('mark_id_conflict', 409);
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
    let mark;
    try {
      ({ mark } = await scope.api('/' + encodeURIComponent(deleted.id) + '/restore', 'POST', { revision: deleted.revision }));
    } catch (error) {
      if (!['mark_not_found', 'mark_revision_conflict'].includes(error.code)) throw error;
      await readDeletedRows(scope).catch(readError => { if (accessLost(readError)) throw readError; });
      scope.check();
      if (error.code === 'mark_not_found') {
        state.deleted = state.deleted.filter(item => item.id !== deleted.id || item.revision !== deleted.revision);
        throw new MarksError('restore_unavailable', 404);
      }
      throw error;
    }
    scope.check();
    state.marks = find(mark.id) ? state.marks.map(row => row.id === mark.id ? mark : row) : [...state.marks, mark];
    state.deleted = state.deleted.filter(item => item.id !== mark.id);
    return mark;
  }

  async function readDeletedRows(scope) {
    const marks = [];
    const { truncated } = await readPages(scope, '/deleted', page => marks.push(...page.marks));
    scope.check();
    // Whether Recently deleted has more than is listed.
    state.deleted = marks;
    state.deletedTruncated = truncated;
    return marks;
  }

  function restored(deleted) {
    const live = find(deleted.id);
    return live?.mine && live.revision > deleted.revision ? live : undefined;
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
        context = next;
        if (state.blocked) { state.blocked = false; emit(); }
        return true;
      }
      if (temporary() && next?.mode === 'temporary' && store.hasTemporaryMarks()) {
        state.blocked = true;
        emit();
        return false;
      }
      cancelSharedRefresh();
      controller?.abort();
      controller = new AbortController();
      attempts = new Map();
      doubt = null;
      pendingImports.clear();
      context = next;
      const scope = currentScope();
      Object.assign(state, { blocked: false, busy: false, message: '', marks: [], categories: [], audiences: [], deleted: [], deletedTruncated: false, undo: [], recoveredChange: null,
        starters: next?.mode === 'temporary' ? STARTER_CATEGORIES.map(starter => starter.key) : [],
        ready: next?.mode === 'temporary', loading: next?.mode === 'session',
        capabilities: { write: next?.mode === 'temporary', staff: false, visibility: ['private'] } });
      emit();
      if (next?.mode !== 'session') {
        if (next?.token) await readSharedPages(scope, page => {
          state.marks = addUnseen(state.marks, page.marks.map(mark => ({ ...mark, mine: false, editable: false })));
          state.categories = byName(addUnseen(state.categories, page.categories));
          emit();
        }).catch(() => {});
        return true;
      }
      try {
        await load(scope);
      } catch (error) {
        if (scope.live() && !staleRefusal(error)) {
          if (accessLost(error)) hideInaccessibleMarks(error, state.ready ? undefined : 'Marks are unavailable for this session.');
          else state.message = 'Marks are unavailable for this session.';
        }
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
    refreshShared,
    cancelSharedRefresh,

    // revision: the version the change was begun from, if the list was read again since.
    // sending: told what goes out and what it is based on, before it does.
    async create(input, { sending } = {}) {
      const mark = { ...input, id: input.id || newId() };
      let saved = null, base = 0;
      const ok = await run(scope => {
        // Its id is there already, from a go that was never answered: that one is brought up to date.
        const now = own(mark.id) ? find(mark.id) : null;
        base = now?.revision || 0;
        sending?.({ revision: base, ...markContent(mark) });
        return now ? updateRaw(now, mark, scope) : createRaw(mark, scope);
      }, { key: 'mark ' + mark.id, makes: true, tried: () => attempted(mark.id, base, mark), mine: () => own(mark.id),
        landed: () => {
          const now = find(mark.id);
          if (!now || (own(mark.id) && !sameMark(now, mark))) return undefined;
          if (!own(mark.id)) throw new MarksError('mark_id_conflict', 0);
          return now;
        },
        done: (made, answered) => {
          saved = made;
          attempts.delete(mark.id);
          if (!answered && made.revision !== 1) return;
          remember({ type: 'create', id: saved.id, revision: saved.revision, label: 'add ' + saved.name, done: saved.name + ' added' });
        } });
      return ok ? saved : null;
    },

    async update(current, changes, { sending, revision = current?.revision } = {}) {
      if (!find(current?.id)) return null;
      let saved = null, base = current, before = current;
      const { id } = current, next = { ...current, ...changes };
      const ok = await run(scope => {
        base = own(id) ? find(id) : { ...current, revision };
        // On top of what may be another tab's: Undo goes back to that, not behind it.
        before = own(id) ? base : current;
        sending?.({ revision: base.revision, ...markContent(next) });
        return updateRaw(base, changes, scope);
      },
        { key: 'mark ' + id, tried: () => attempted(id, base.revision, next), mine: () => own(id),
        landed: () => {
          const now = find(id);
          if (own(id)) return sameMark(now, next) ? now : undefined;
          // Read again meanwhile, and not as it was: the person is told before anything is written over.
          if (now?.revision !== base.revision) throw new MarksError(now ? 'mark_revision_conflict' : 'mark_gone', 0);
          return undefined;
        },
        done: (made, answered) => {
        saved = made;
        attempts.delete(id);
        if (!answered) return;
        const moved = JSON.stringify(saved.geometry) !== JSON.stringify(current.geometry)
          && ['name', 'note', 'categoryId', 'color', 'icon', 'elevationNavd88M', 'visibility'].every(field => (saved[field] ?? null) === (current[field] ?? null));
        remember({ type: 'update', id: current.id, revision: saved.revision, before, label: 'edit ' + current.name, done: saved.name + (moved ? ' moved' : ' changed') });
      } });
      return ok ? saved : null;
    },

    // permanent: the person said for good, so there is nothing to undo.
    async remove(current, { permanent = false } = {}) {
      if (!find(current?.id)) return false;
      let base = current;
      const went = departure(current.id, () => base.revision);
      return run(async scope => { base = based(current); await removeRaw(base, scope, { permanent }); }, { key: `delete ${current.id} ${permanent}`,
        look: went.look, mine: () => own(current.id),
        landed: () => {
          const where = went.where();
          if (where === UNKNOWN) return UNKNOWN;
          if (where === 'there') return undefined;
          if (where === (permanent ? 'gone' : 'deleted')) return true;
          // Not what was asked for, or not this one's doing: nothing to undo comes of it.
          throw new MarksError(permanent ? 'still_recoverable' : 'mark_gone', 0);
        },
        done: (_, answered) => {
          // For good: nothing about it can be undone any more.
          // An import is undone whole or not at all.
          if (permanent) state.undo = state.undo.filter(entry => entry.id !== current.id && entry.before?.id !== current.id && !entry.marks?.some(mark => mark.id === current.id));
          else if (answered) remember({ type: 'delete', before: current, revision: base.revision, label: 'delete ' + current.name, done: current.name + ' deleted' });
          if (!answered) noteRecovered(permanent ? current.name + ' is gone.' : current.name + ' is in Recently deleted.');
        } });
    },

    // The owner's own recently deleted marks, read when asked for.
    async loadDeleted() {
      if (!context || temporary()) return false;
      return run(readDeletedRows);
    },
    async restore(deleted) {
      if (!state.deleted.some(item => item.id === deleted?.id)) return null;
      let saved = null;
      const landed = () => restored(deleted);
      const ok = await run(scope => restoreRaw(deleted, scope), { key: 'restore ' + deleted.id, mine: landed, landed,
        done: (mark, answered) => {
          saved = mark;
          state.deleted = state.deleted.filter(item => item.id !== mark.id);
          if (!answered) {
            noteRecovered(mark.name + ' is back in Marks.');
            return;
          }
          follow(mark.id, deleted.revision, mark.revision);
          remember({ type: 'create', id: saved.id, revision: saved.revision, label: 'restore ' + saved.name, done: saved.name + ' restored' });
        } });
      return ok ? saved : null;
    },

    // Staff: share all of one's own marks that are not, as many requests as it takes.
    async shareAll(access = 'edit') {
      const unshared = () => state.marks.filter(mark => mark.mine && mark.visibility !== 'shared');
      let done = true;
      while (done && state.capabilities.shareAll && unshared().length) {
        const some = unshared().slice(0, 500).map(({ id, revision }) => ({ id, revision }));
        done = await run(async scope => {
          const { marks } = await scope.api('/batch/share', 'POST', { marks: some, access });
          scope.check();
          const saved = new Map(marks.map(mark => [mark.id, mark]));
          state.marks = state.marks.map(mark => saved.get(mark.id) || mark);
        }, { landed: () => (some.every(item => find(item.id)?.visibility === 'shared') ? true : undefined) });
      }
      return done;
    },

    // Staff: earlier versions of a shared mark, newest first, and going back to one.
    async history(current) {
      let versions = null;
      const ok = await run(async scope => { ({ versions } = await scope.api('/' + encodeURIComponent(current.id) + '/history')); scope.check(); });
      return ok ? versions : null;
    },
    async revert(current, to) {
      let saved = null;
      const ok = await run(async scope => {
        const { mark } = await scope.api('/' + encodeURIComponent(current.id) + '/revert', 'POST', { revision: current.revision, ...(to && { to }) });
        scope.check();
        saved = mark;
        state.marks = state.marks.map(row => (row.id === mark.id ? mark : row));
      });
      return ok ? saved : null;
    },

    // Undo the last change made in this tab.
    async undo() {
      const entry = state.undo.at(-1);
      if (!entry) return false;
      const held = store.hold();
      const id = entry.id ?? entry.before?.id, current = find(id), before = entry.before && body(entry.before);
      // What it would take back is not what is there any more.
      const moved = ['create', 'update'].includes(entry.type) && current && current.revision !== entry.revision && !own(id);
      let base = current, made = null, gone = null;
      const went = departure(id, () => base?.revision);
      const plan = {
        create: {
          send: async scope => { base = current && based(current); if (base) await removeRaw(base, scope); },
          look: went.look,
          landed: () => {
            const where = went.where();
            if (where === 'there') return undefined;
            if (where === 'deleted' || where === UNKNOWN) return where === UNKNOWN ? UNKNOWN : true;
            throw new MarksError('mark_gone', 0);
          },
        },
        import: {
          // Exactly what the import returned, in one request: all of it as it was, or nothing.
          send: async scope => {
            if (scope.temporary) {
              if (entry.marks.some(mark => find(mark.id)?.revision !== mark.revision)) throw new MarksError('import_changed', 409);
            } else {
              try { await scope.api('/batch/delete', 'POST', { marks: entry.marks }); }
              catch (error) { throw ['mark_revision_conflict', 'mark_not_found', 'mark_edit_forbidden'].includes(error.code) ? new MarksError('import_changed', 409) : error; }
            }
            scope.check();
            const ids = new Set(entry.marks.map(mark => mark.id));
            state.marks = state.marks.filter(mark => !ids.has(mark.id));
          },
          look: async scope => {
            const page = await scope.api('/deleted');
            scope.check();
            gone = page.marks;
            Object.assign(state, { deleted: gone, deletedTruncated: Boolean(page.next) });
          },
          landed: () => {
            if (entry.marks.every(mark => find(mark.id))) return undefined;
            if (!gone || !state.capabilities.write) return UNKNOWN;
            if (entry.marks.every(mark => !find(mark.id) && gone.find(row => row.id === mark.id)?.revision === mark.revision)) return true;
            throw new MarksError('undo_unclear', 0);
          },
        },
        update: {
          send: async scope => {
            if (!current) throw new MarksError('mark_revision_conflict', 409);
            base = based(current);
            made = await updateRaw(base, before, scope);
          },
          tried: () => { if (base) attempted(id, base.revision, before); },
          mine: () => own(id),
          landed: () => (own(id) && sameMark(find(id), before) ? find(id) : undefined),
        },
        delete: {
          send: async scope => { made = scope.temporary ? await createRaw(entry.before, scope) : await restoreRaw(entry.before, scope); },
          mine: () => restored(entry.before),
          landed: () => restored(entry.before),
        },
      }[entry.type];
      const ok = await run(async scope => {
        if (state.undo.at(-1) !== entry) throw new MarksError('undo_target_changed', 0);
        if (moved) throw new MarksError('undo_moved', 0);
        await plan.send(scope);
      }, { key: 'undo ' + entry.at, look: plan.look, landed: plan.landed, tried: plan.tried, mine: plan.mine,
        done: (_, answered) => {
          // By order: deleting a category rewrites entries.
          state.undo = state.undo.filter(item => item.at !== entry.at);
          if (entry.type === 'update') attempts.delete(id);
          if (answered && made) follow(id, entry.before.revision, made.revision);
        } });
      if (!held.live()) return false;
      // A change that has moved underneath can never be undone; anything else can be tried again.
      const never = ['mark_revision_conflict', 'mark_not_found', 'restore_unavailable', 'mark_edit_forbidden', 'mark_category_not_found', 'import_changed', 'undo_moved'].includes(state.failure);
      if (ok || never) state.undo = state.undo.filter(item => item.at !== entry.at);
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
      let saved = null, tried = false;
      const payload = { id: input.id || newId(), name: input.name.trim(), color: input.color, icon: input.icon };
      // A name is only there once, so the same one with the same look is this one.
      const is = row => row.mine && ['name', 'color', 'icon'].every(field => row[field].toLowerCase() === payload[field].toLowerCase())
        && (input.id ? row.id === input.id && row.revision === input.revision + 1 : true);
      const landed = () => state.categories.find(is);
      const ok = await run(async scope => {
        const made = input.id
          ? (await scope.api('/categories/' + encodeURIComponent(input.id), 'PUT', { ...payload, revision: input.revision })).category
          : (await scope.api('/categories', 'POST', payload)).category;
        scope.check();
        if (!input.id) beganOwn();
        state.categories = byName([...state.categories.filter(row => row.id !== made.id), made]);
        return made;
      }, { key: `category ${input.id || payload.name.toLowerCase()}`, makes: !input.id, landed, tried: () => { tried = true; },
        mine: () => tried && Boolean(landed()), done: made => { saved = made; } });
      return ok ? saved : null;
    },

    async deleteCategory(category) {
      const held = store.hold();
      let tried = false;
      const gone = () => (state.categories.some(row => row.id === category.id) ? undefined : state.capabilities.write ? true : UNKNOWN);
      const done = () => {
        state.categories = state.categories.filter(row => row.id !== category.id);
        const without = mark => (mark?.categoryId === category.id ? { ...mark, categoryId: null } : mark);
        state.marks = state.marks.map(without);
        state.undo = state.undo.map(item => {
          const before = without(item.before);
          return before === item.before ? item : { ...item, before };
        });
      };
      if (temporary()) done();
      else {
        const ok = await run(async scope => {
          await scope.api('/categories/' + encodeURIComponent(category.id), 'DELETE', { revision: category.revision });
        }, { key: 'delete category ' + category.id, landed: gone, tried: () => { tried = true; }, mine: () => tried && gone() === true, done });
        if (!ok || !held.live()) return false;
      }
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
        const made = scope.temporary ? { id: newId(), name, color, icon, revision: 1, mine: true, editable: true }
          : (await scope.api('/categories/starter', 'POST', { key, name, color, icon })).category;
        scope.check();
        state.categories = byName([...state.categories.filter(row => row.id !== made.id), made]);
        state.starters = state.starters.filter(item => item !== key);
        return made;
      }, { key: 'starter ' + key, done: made => { saved = made; },
        landed: () => (state.starters.includes(key) ? undefined : state.categories.find(row => row.mine && row.name.toLowerCase() === name.toLowerCase())) });
      return ok ? saved : null;
    },

    // categories: new ones the file names; marks reference their ids.
    async importMarks({ marks, categories = [], retryIdentity }, { onImported } = {}) {
      if (!marks.length) return 0;
      let importedRows = [];
      // The same file again, after a go that was never answered: with the ids it had then.
      const named = new Map(categories.map(({ id, name, color, icon }) => [id, [name, color, icon]]));
      const signature = retryIdentity !== undefined ? 'file ' + retryIdentity
        : JSON.stringify([marks.map(mark => [{ ...markContent(mark), categoryId: null }, named.get(mark.categoryId) || mark.categoryId || null]), [...named.values()]]);
      const pending = pendingImports.get(signature);
      if (pending) ({ marks, categories } = pending);
      // Any of them being there says it was made; only all of them, as they were made, can be undone.
      const asMade = (rows, content) => rows.length === marks.length
        && rows.every((row, index) => row.mine && row.revision === 1 && row.id === marks[index].id && (!content || sameMark(row, marks[index])));
      const landed = () => {
        const rows = marks.map(mark => find(mark.id)).filter(row => row?.mine);
        return rows.length ? { rows, exact: asMade(rows, true) } : undefined;
      };
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
          state.marks = [...state.marks.filter(mark => !saved.marks.some(row => row.id === mark.id)), ...saved.marks];
          if (saved.categories.length) beganOwn();
          state.categories = byName([...state.categories, ...saved.categories.filter(row => !state.categories.some(item => item.id === row.id))]);
          imported = saved.marks;
        }
        // Sent again, the server answers with what is there now, which may have been changed since.
        return { rows: imported, exact: asMade(imported, false) };
      }, { key: 'import ' + signature, makes: true, landed, tried: () => { pendingImports.set(signature, { marks, categories }); },
        mine: () => pendingImports.has(signature) && Boolean(landed()),
        async refused(scope, error) {
          if (!pendingImports.has(signature) || !state.capabilities.write
            || !['mark_category_name_taken', 'mark_category_id_conflict', 'mark_category_not_found', 'mark_id_conflict'].includes(error.code)) return;
          // Only a single snapshot of all owned IDs can distinguish absence
          // from a mark moving between live and deleted during readback.
          const ids = marks.map(mark => mark.id);
          const status = await scope.api('/batch/status', 'POST', { ids }, { readOnly: true }).catch(readError => {
            if (accessLost(readError)) throw readError;
            return null;
          });
          scope.check();
          if (Array.isArray(status?.reservedIds) && !status.reservedIds.length) pendingImports.delete(signature);
        },
        done: ({ rows: imported, exact }) => {
        pendingImports.delete(signature);
        importedRows = imported;
        if (!exact) { state.message = MESSAGES.import_unsure; return; }
        const count = imported.length;
        remember({ type: 'import', marks: Object.freeze(imported.map(({ id, revision }) => Object.freeze({ id, revision }))), label: `import ${count} marks`, done: `${count} mark${count === 1 ? '' : 's'} imported` });
      } });
      if (ok) onImported?.(importedRows);
      return ok ? importedRows.length : 0;
    },

    // A draft kept over a reload: what was sent for it before, so it is recognised.
    expect(id, sent) { if (id && sent?.length) attempts.set(id, sent); },

    hasTemporaryMarks: () => Boolean(temporary() && state.marks.length),
    discardTemporaryMarks() {
      if (!temporary()) return;
      state.marks = [];
      state.undo = [];
      emit();
    },
    clearMessage() { state.message = ''; },
    dispose() { cancelSharedRefresh(); controller?.abort(); context = null; },
  };
  return store;
}
