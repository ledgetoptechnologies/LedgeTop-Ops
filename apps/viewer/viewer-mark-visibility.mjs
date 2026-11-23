// Which mark categories this person hides on this project, in this browser.
// A viewing choice only: it never changes a mark or who can read it, and what
// is stored is category ids, without the person's identity.
const KEY = 'ltds.viewer.marks.hidden';
const MAX_SCOPES = 50, MAX_IDS = 250;
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
  let hidden = new Set(), label = null;
  const readAll = () => {
    try {
      const entries = JSON.parse(storage()?.getItem(KEY) || '[]');
      return Array.isArray(entries) ? entries.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])) : [];
    } catch { return []; }
  };
  // Most recent scope first; the oldest ones are dropped.
  function write() {
    if (!label) return;
    const others = readAll().filter(([name]) => name !== label);
    const entries = hidden.size ? [[label, [...hidden].slice(0, MAX_IDS)], ...others] : others;
    try { storage()?.setItem(KEY, JSON.stringify(entries.slice(0, MAX_SCOPES))); } catch { /* this page only */ }
  }
  const change = next => { hidden = new Set(next); write(); };
  return {
    // key is null when nothing should be remembered (public links, no access).
    setScope(key) {
      label = key ? scopeLabel(key) : null;
      hidden = new Set((label && readAll().find(([name]) => name === label)?.[1].filter(id => typeof id === 'string').slice(0, MAX_IDS)) || []);
    },
    isHidden: id => hidden.has(id),
    shows: mark => !hidden.has(categoryOf(mark)),
    toggle(id) { change(hidden.has(id) ? [...hidden].filter(item => item !== id) : [...hidden, id]); },
    show(ids) { if (ids.some(id => hidden.has(id))) change([...hidden].filter(id => !ids.includes(id))); },
    showAll() { if (hidden.size) change([]); },
    hideAll(all) { change(all); },
    // Only this one: every other category there is gets hidden.
    only(id, all) { change(all.filter(item => item !== id)); },
    isOnly: (id, all) => all.length > 1 && !hidden.has(id) && all.every(item => item === id || hidden.has(item)),
  };
}
