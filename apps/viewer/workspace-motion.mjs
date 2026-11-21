// Workspace motion: one place for the Viewer workspace's UI animation, built on Motion (motion.dev).
// The workspace renders by replacing HTML, so this module watches the DOM instead of being called by
// each renderer. It only animates transform and opacity (plus a short height collapse for rows that
// leave). Progress tweens change only the paint of the bar; the native value stays authoritative.
import { animate, stagger } from 'motion';

export const EASE_OUT = [0.22, 1, 0.36, 1];
export const DURATION = Object.freeze({ fast: 0.16, base: 0.22, progress: 0.45 });

/** Rows with a stable identity across re-renders: they fade in when new and fold away when gone. */
export const KEYED_ROW_ATTRIBUTES = Object.freeze(['data-operation-id', 'data-derivative-id', 'data-attempt-id', 'data-diagnostic-attempt-id', 'data-project-name']);
const KEYED_ROW_SELECTOR = KEYED_ROW_ATTRIBUTES.map(name => `[${name}]`).join(',');
/** Only background-work rows get a leave animation; other lists re-render as whole pages. */
const LEAVING_ROW_SELECTOR = '[data-operation-id],[data-derivative-id]';
const PAGE_BLOCK_SELECTOR = ':scope > :is(.content-card, .metric-card, section, article, form, .management-grid, .project-columns, .share-columns, .recycle-bin, div)';
const MAX_STAGGERED = 8;
const MAX_EXIT_SNAPSHOT = 32;

export function rowKey(element) {
  for (const name of KEYED_ROW_ATTRIBUTES) {
    const value = element?.getAttribute?.(name);
    if (value) return `${name}=${value}`;
  }
  return '';
}

/** A progress bar's identity: its keyed row plus its accessible name, so tweens survive re-renders. */
export function progressKey(progress) {
  const row = progress?.closest?.(KEYED_ROW_SELECTOR);
  const key = row ? rowKey(row) : '';
  return key ? `${key}|${progress.getAttribute('aria-label') || ''}` : '';
}

function progressPercent(progress) {
  if (!progress?.hasAttribute?.('value')) return null;
  const value = Number(progress.getAttribute('value'));
  const max = Number(progress.getAttribute('max'));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value / (Number.isFinite(max) && max > 0 ? max : 1))) * 100 : null;
}

/** Percentages keep the visual tween independent of the native bar's scale. */
export function progressTween(previous, progress) {
  const next = progressPercent(progress);
  if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === next) return null;
  return { from: previous, to: next };
}

export function prefersReducedMotion(windowRef = globalThis.window) {
  try { return Boolean(windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}

/** The workspace page currently shown: its section in the URL plus its title. */
export function pageKey(documentRef = globalThis.document, locationRef = globalThis.location) {
  let section = '';
  try { const url = new URL(locationRef.href); section = `${url.searchParams.get('section') || ''}|${url.searchParams.get('task') || ''}`; } catch { /* Title alone still separates pages. */ }
  return `${section}|${documentRef?.querySelector?.('#page-title')?.textContent || ''}`;
}

function stripIdentity(root) {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const { name } of [...element.attributes]) if (name === 'id' || name === 'name' || name.startsWith('data-') || name.startsWith('aria-')) element.removeAttribute(name);
  }
  root.setAttribute('aria-hidden', 'true');
  root.inert = true;
}

function restoreInlineStyles(element, properties) {
  const styles = properties.map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
  return () => {
    for (const [name, value, priority] of styles) {
      if (value) element.style.setProperty(name, value, priority);
      else element.style.removeProperty(name);
    }
  };
}

/**
 * Starts animating the workspace. Returns a stop function. `animateImpl` is injectable for tests.
 */
export function installWorkspaceMotion({ documentRef = document, windowRef = window, content = documentRef.querySelector('#workspace-content'), animateImpl = animate } = {}) {
  const Observer = windowRef.MutationObserver ?? globalThis.MutationObserver;
  if (!content || !Observer) return () => {};
  const reduced = () => prefersReducedMotion(windowRef);
  let knownRows = new Set();
  let exitSnapshot = [];
  let progressValues = new Map();
  const effects = new Map();
  let currentPage = null;

  function stopEffects() {
    for (const finish of effects.values()) finish(true);
  }

  const requestFrame = callback => windowRef.requestAnimationFrame ? windowRef.requestAnimationFrame(callback) : setTimeout(callback, 16);
  const cancelFrame = frame => windowRef.cancelAnimationFrame ? windowRef.cancelAnimationFrame(frame) : clearTimeout(frame);

  function play(element, start, cleanup, nextFrame = false) {
    let controls;
    let frame;
    const current = () => effects.get(element) === finish;
    function finish(stop = false) {
      if (!current()) return;
      effects.delete(element);
      if (frame !== undefined) cancelFrame(frame);
      if (stop) controls?.stop();
      cleanup();
    }
    effects.set(element, finish);
    try { controls = start(current); } catch (error) { finish(); throw error; }
    Promise.resolve(controls).then(() => {
      if (!current()) return;
      if (nextFrame) frame = requestFrame(() => finish());
      else finish();
    }, () => finish());
  }

  const rememberProgress = root => {
    const values = new Map();
    let remaining = MAX_STAGGERED;
    for (const progress of root.querySelectorAll('progress')) {
      const key = progressKey(progress);
      if (!key) continue;
      const value = progressPercent(progress);
      const previous = progressValues.get(key);
      if (value === null) effects.get(progress)?.(true);
      else values.set(key, value);
      const tween = reduced() ? null : progressTween(previous, progress);
      if (!tween) continue;
      effects.get(progress)?.(true);
      if (!remaining) continue;
      remaining--;
      const restore = restoreInlineStyles(progress, ['--motion-progress']);
      const paint = latest => progress.style.setProperty('--motion-progress', `${latest}%`);
      paint(tween.from);
      progress.classList.add('motion-progress-tween');
      play(progress, current => animateImpl(tween.from, tween.to, {
        duration: DURATION.progress, ease: EASE_OUT, onUpdate: latest => { if (current()) paint(latest); },
      }), () => { restore(); progress.classList.remove('motion-progress-tween'); });
    }
    progressValues = values;
  };

  // Motion can write its final frame after its controls resolve. Restore inline styles a frame later.
  const animateStyles = (element, keyframes, options, properties) => {
    effects.get(element)?.(true);
    play(element, () => animateImpl(element, keyframes, options), restoreInlineStyles(element, properties), true);
  };
  const enter = (targets, { y = 0, scale = 1, delay } = {}) => {
    const elements = [].concat(targets).slice(0, MAX_STAGGERED);
    const keyframes = { opacity: [0, 1], y: [y, 0] };
    if (scale !== 1) keyframes.scale = [scale, 1];
    elements.forEach((element, index) => animateStyles(element, keyframes, {
      duration: DURATION.base, ease: EASE_OUT, delay: delay?.(index, elements.length),
    }, ['opacity', 'transform']));
  };

  const enterPage = section => {
    const blocks = [...section.querySelectorAll(PAGE_BLOCK_SELECTOR)].filter(element => !element.hidden).slice(0, MAX_STAGGERED);
    enter(blocks, { y: 6, delay: stagger(0.035) });
  };

  const enterRows = rows => enter(rows, { y: -4, delay: stagger(0.03) });

  // A replaced list drops its old rows at once; put a copy of each row that really left back in its
  // old place, fold it away, then remove it. The copy has no ids, data or names, so nothing reads it.
  const leaveRows = anchorsByKey => {
    let remaining = MAX_STAGGERED;
    for (const [index, { element, key, list: previousList }] of exitSnapshot.entries()) {
      if (!remaining) break;
      if (anchorsByKey.has(key)) continue;
      const anchor = (candidate) => candidate.list === previousList && anchorsByKey.has(candidate.key);
      const after = anchorsByKey.get(exitSnapshot.slice(0, index).findLast(anchor)?.key);
      const before = !after && anchorsByKey.get(exitSnapshot.slice(index + 1).find(anchor)?.key);
      const list = (after || before)?.parentElement;
      if (!list) continue;
      remaining--;
      const ghost = element.cloneNode(true);
      stripIdentity(ghost);
      ghost.classList.add('motion-leaving');
      if (after) after.after(ghost); else before.before(ghost);
      anchorsByKey.set(key, ghost);
      const height = ghost.getBoundingClientRect().height;
      const gap = Number.parseFloat(windowRef.getComputedStyle(list).rowGap) || 0;
      // Fold the row and the gap it adds, so the rows below settle without a final jump.
      play(ghost, () => animateImpl(ghost, { opacity: [1, 0], height: [`${height}px`, '0px'], paddingTop: [null, '0px'], paddingBottom: [null, '0px'], borderTopWidth: [null, '0px'], borderBottomWidth: [null, '0px'], marginTop: ['0px', `-${gap}px`] }, { duration: DURATION.base, ease: EASE_OUT }), () => ghost.remove());
    }
  };

  const onContentMutations = () => {
    const section = content.firstElementChild;
    const page = pageKey(documentRef, windowRef.location);
    const pageChanged = page !== currentPage;
    currentPage = page;
    if (pageChanged) { stopEffects(); progressValues.clear(); }
    else for (const [element, finish] of effects) if (!element.isConnected) finish(true);
    const rows = [...content.querySelectorAll(KEYED_ROW_SELECTOR)];
    const byKey = new Map(rows.map(row => [rowKey(row), row]));
    if (!reduced()) {
      if (pageChanged) {
        if (section) enterPage(section);
      } else {
        enterRows(rows.filter(row => !knownRows.has(rowKey(row))));
        if (rows.length <= MAX_EXIT_SNAPSHOT) leaveRows(byKey);
      }
    }
    knownRows = new Set(rows.map(rowKey));
    // Bulk views never retain or rescan removed DOM subtrees for leave animations.
    exitSnapshot = rows.length <= MAX_EXIT_SNAPSHOT
      ? rows.filter(row => row.matches(LEAVING_ROW_SELECTOR)).map(element => ({ element, key: rowKey(element), list: element.parentElement }))
      : [];
    rememberProgress(content);
  };

  const contentObserver = new Observer(onContentMutations);
  contentObserver.observe(content, { childList: true, attributes: true, attributeFilter: ['value', 'max'], subtree: true });

  // Dialogs, the toast and the background-work count live outside the page content.
  const lastToastDisplay = { value: '' };
  const chromeObserver = new Observer(records => {
    if (reduced()) return;
    for (const record of records) {
      const target = record.target;
      if (record.type === 'attributes' && record.attributeName === 'open' && target.localName === 'dialog' && target.open && !record.oldValue) {
        enter(target, { y: 8, scale: 0.985 });
      } else if (record.type === 'attributes' && target.id === 'workspace-toast') {
        const display = target.style.display;
        if (display && display !== 'none' && lastToastDisplay.value !== display) enter(target, { y: 10 });
        lastToastDisplay.value = display;
      } else if (target.id === 'background-work-count' || target.parentElement?.id === 'background-work-count') {
        const shown = count?.textContent;
        if (count && shown !== lastCount) {
          animateStyles(count, { scale: [1.25, 1] }, { type: 'spring', bounce: 0.3, visualDuration: DURATION.base }, ['transform']);
          lastCount = shown;
        }
      }
    }
  });
  chromeObserver.observe(documentRef.body, { attributes: true, attributeFilter: ['open', 'style'], attributeOldValue: true, subtree: true });
  const count = documentRef.querySelector('#background-work-count');
  let lastCount = count?.textContent;
  if (count) chromeObserver.observe(count, { childList: true, characterData: true, subtree: true });

  let preference;
  try { preference = windowRef.matchMedia?.('(prefers-reduced-motion: reduce)'); } catch { /* No media query support. */ }
  const onPreferenceChange = event => { if (event.matches) stopEffects(); };
  preference?.addEventListener?.('change', onPreferenceChange);
  windowRef.addEventListener?.('pagehide', stopEffects);
  onContentMutations();
  return () => {
    contentObserver.disconnect();
    chromeObserver.disconnect();
    preference?.removeEventListener?.('change', onPreferenceChange);
    windowRef.removeEventListener?.('pagehide', stopEffects);
    stopEffects();
  };
}

if (typeof document !== 'undefined' && document.querySelector('#workspace-content')) installWorkspaceMotion();
