// Which mark categories this person hides on this project, in this browser.
// A viewing choice only: it never changes a mark or who can read it, and what
// is stored is category ids, without the person's identity.
//
// The choice is kept as it was made: "everything" or "everything except these",
// or "nothing except these". So Hide all and Only this stay that choice however
// many categories there are, now or later.
const KEY = 'ltds.viewer.marks.hidden';
const MAX_SCOPES = 50;
export const NO_CATEGORY = 'none';
export const categoryOf = mark => mark.categoryId || NO_CATEGORY;

// A short fixed label for the scope, so the stored list does not hold the identity.
function scopeLabel(key) {
  let a = 0x811c9dc5, b = 0x1000193;
  for (const character of key) {
    const code = character.codePointAt(0);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

export function createMarkVisibility({ storage = () => globalThis.localStorage } = {}) {
  // all: everything is hidden except `except`; otherwise everything is shown except it.
  let all = false, except = new Set(), label = null, kept = true;
  const readAll = () => {
    try {
      const entries = JSON.parse(storage()?.getItem(KEY) || '[]');
      return Array.isArray(entries) ? entries.filter(entry => Array.isArray(entry) && entry.length === 3 && typeof entry[0] === 'string'
        && typeof entry[1] === 'boolean' && Array.isArray(entry[2])) : [];
    } catch { return []; }
  };
  // Most recent scope first. When there is no room, older scopes give way; this
  // one is written whole or not at all, and remembered() says which.
  function write() {
    kept = true;
    if (!label) return;
    const others = readAll().filter(([name]) => name !== label).slice(0, MAX_SCOPES - 1);
    const entries = all || except.size ? [[label, all, [...except]], ...others] : others;
    for (;;) {
      try { storage().setItem(KEY, JSON.stringify(entries)); return; }
      catch {
        if (entries.length <= 1) { kept = false; return; }
        entries.splice(Math.ceil(entries.length / 2));
      }
    }
  }
  const set = (nextAll, nextExcept) => { all = nextAll; except = new Set(nextExcept); write(); };
  const isHidden = id => except.has(id) !== all;
  return {
    // key is null when nothing should be remembered (public links, no access).
    setScope(key) {
      label = key ? scopeLabel(key) : null;
      const saved = label && readAll().find(([name]) => name === label);
      all = Boolean(saved?.[1]);
      except = new Set(saved ? saved[2].filter(id => typeof id === 'string') : []);
      kept = true;
    },
    isHidden,
    shows: mark => !isHidden(categoryOf(mark)),
    toggle(id) { set(all, except.has(id) ? [...except].filter(item => item !== id) : [...except, id]); },
    show(ids) {
      const now = ids.filter(isHidden);
      if (now.length) set(all, all ? [...except, ...now] : [...except].filter(id => !now.includes(id)));
    },
    showAll() { set(false, []); },
    hideAll() { set(true, []); },
    // Only this one: every other category is hidden.
    only(id) { set(true, [id]); },
    isOnly: (id, ids) => ids.length > 1 && !isHidden(id) && ids.every(item => item === id || isHidden(item)),
    remembered: () => kept,
  };
}
