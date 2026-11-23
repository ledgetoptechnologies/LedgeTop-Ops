// Keeps one unsaved mark edit in this browser tab so a reload or an expired
// session does not lose it. It is the person's own typing and never grants
// anything: it is only read back for the same person on the same model, and
// saving it goes through the API like any other edit.
const SLOT = 'ltds-viewer-mark-draft';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const text = (value, max) => typeof value === 'string' && value.length <= max;
const idOrNull = value => value === null || (typeof value === 'string' && UUID.test(value));
const position = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const positions = value => Array.isArray(value) && value.length <= 501 && value.every(position);

function validGeometry(geometry) {
  const { type, coordinates } = geometry || {};
  if (type === 'Point') return position(coordinates);
  if (type === 'LineString') return positions(coordinates) && coordinates.length >= 2;
  return type === 'Polygon' && Array.isArray(coordinates) && coordinates.length === 1 && positions(coordinates[0]) && coordinates[0].length >= 4;
}

export function validMarkDraft(draft) {
  if (!draft || typeof draft !== 'object') return false;
  if (draft.kind === 'drawing') return ['LineString', 'Polygon'].includes(draft.type) && positions(draft.positions) && draft.positions.length > 0;
  return draft.kind === 'editor' && idOrNull(draft.id) && idOrNull(draft.newId) && Boolean(draft.id || draft.newId)
    && (draft.id === null || (Number.isSafeInteger(draft.revision) && draft.revision > 0)) && validGeometry(draft.geometry)
    && text(draft.name, 100) && text(draft.note, 2000) && idOrNull(draft.categoryId) && text(draft.color, 7) && text(draft.icon, 32)
    && text(draft.elevation, 40) && ['imperial', 'metric'].includes(draft.units) && (draft.coordinates === null || text(draft.coordinates, 120))
    && text(draft.visibility, 16) && (draft.starter === undefined || draft.starter === null || text(draft.starter, 32));
}

// What an editor draft becomes when it is restored. It is never written over a
// mark that changed or went away meanwhile: then it opens as a new mark.
export function reconcileMarkDraft(draft, find, newId) {
  const existing = find(draft.id || draft.newId);
  const current = existing?.mine && existing.editable && existing.geometry.type === draft.geometry.type ? existing : null;
  if (!draft.id) {
    // The save may have reached the server before its answer was lost.
    return current ? { ...draft, id: current.id, newId: null, revision: current.revision, changedElsewhere: false }
      : { ...draft, newId: existing ? newId() : draft.newId, changedElsewhere: false };
  }
  if (current && current.revision === draft.revision) return { ...draft, newId: null, changedElsewhere: false };
  return { ...draft, id: null, newId: newId(), revision: null, changedElsewhere: true };
}


export function createMarkDraftRecovery({ storage = () => globalThis.sessionStorage, now = () => Date.now() } = {}) {
  let memory = null; // Storage can be blocked: this page still keeps the draft.
  const clear = () => {
    memory = null;
    try { storage()?.removeItem(SLOT); } catch { /* nothing stored */ }
  };
  return {
    save(key, draft) {
      if (!key || !validMarkDraft(draft)) return;
      memory = JSON.stringify({ key, savedAt: now(), draft });
      try { storage()?.setItem(SLOT, memory); } catch { /* memory only */ }
    },
    // The draft for exactly this person and model. Anything else is discarded.
    read(key) {
      let stored = memory;
      if (!stored) { try { stored = storage()?.getItem(SLOT); } catch { /* none */ } }
      if (!stored) return null;
      let saved = null;
      try { saved = JSON.parse(stored); } catch { /* discarded below */ }
      const age = now() - saved?.savedAt;
      if (!key || saved?.key !== key || !(age >= 0 && age <= MAX_AGE_MS) || !validMarkDraft(saved.draft)) { clear(); return null; }
      return saved.draft;
    },
    clear,
  };
}
