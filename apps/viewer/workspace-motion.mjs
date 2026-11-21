// Workspace motion: one place for the Viewer workspace's UI animation, built on Motion (motion.dev).
// The workspace renders by replacing HTML, so this module watches the DOM instead of being called by
// each renderer. It only animates transform and opacity (plus a short height collapse for rows that
// leave), never changes text, ids or attributes the app reads, and does nothing when the visitor
// asks for reduced motion.
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

/** Determinate bars tween from the last value shown; indeterminate bars are never given a value. */
export function progressTween(previous, progress) {
  if (!progress?.hasAttribute?.('value')) return null;
  const next = Number(progress.getAttribute('value'));
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

/**
 * Starts animating the workspace. Returns a stop function. `animateImpl` is injectable for tests.
 */
export function installWorkspaceMotion({ documentRef = document, windowRef = window, content = documentRef.querySelector('#workspace-content'), animateImpl = animate } = {}) {
  if (!content || typeof MutationObserver === 'undefined') return () => {};
  const reduced = () => prefersReducedMotion(windowRef);
  const knownRows = new Set();
  const progressValues = new Map();
  const runningTweens = new Map();
  let currentPage = null;

  const rememberProgress = root => {
    for (const progress of root.querySelectorAll('progress')) {
      const key = progressKey(progress);
      if (!key) continue;
      const running = runningTweens.get(key);
      if (running && running.element !== progress) { running.controls.stop(); runningTweens.delete(key); }
      const tween = reduced() ? null : progressTween(progressValues.get(key), progress);
      if (progress.hasAttribute('value')) progressValues.set(key, Number(progress.getAttribute('value')));
      else progressValues.delete(key);
      if (!tween) continue;
      // The visible percentage text is already final; the bar eases there from the last value shown.
      progress.value = tween.from;
      const controls = animateImpl(tween.from, tween.to, { duration: DURATION.progress, ease: EASE_OUT, onUpdate: latest => { progress.value = latest; } });
      runningTweens.set(key, { element: progress, controls });
      Promise.resolve(controls).then(() => { if (runningTweens.get(key)?.controls === controls) runningTweens.delete(key); }, () => {});
    }
  };

  // Once an entrance finishes, drop the inline opacity/transform so no element keeps a transform
  // (which would change stacking and fixed positioning inside it).
  // Motion writes its last frame after `finished` resolves, so clear on the following frame.
  const nextFrame = () => new Promise(resolve => (windowRef.requestAnimationFrame ? windowRef.requestAnimationFrame(() => resolve()) : setTimeout(resolve, 16)));
  const settle = (controls, elements) => Promise.resolve(controls).then(nextFrame).then(() => {
    for (const element of elements) { element.style.removeProperty('opacity'); element.style.removeProperty('transform'); }
  }, () => {});
  const enter = (targets, { y = 0, scale = 1, delay } = {}) => {
    const elements = [].concat(targets);
    if (!elements.length) return;
    const keyframes = { opacity: [0, 1], y: [y, 0] };
    if (scale !== 1) keyframes.scale = [scale, 1];
    settle(animateImpl(elements, keyframes, { duration: DURATION.base, ease: EASE_OUT, delay }), elements);
  };

  const enterPage = section => {
    const blocks = [...section.querySelectorAll(PAGE_BLOCK_SELECTOR)].filter(element => !element.hidden).slice(0, MAX_STAGGERED);
    enter(blocks, { y: 6, delay: stagger(0.035) });
  };

  const enterRows = rows => enter(rows, { y: -4, delay: stagger(0.03) });

  // A replaced list drops its old rows at once; put a copy of each row that really left back in its
  // old place, fold it away, then remove it. The copy has no ids, data or names, so nothing reads it.
  const leaveRows = (removed, anchorsByKey) => {
    for (const { element, key, previousKey, nextKey } of removed) {
      const after = previousKey ? anchorsByKey.get(previousKey) : null;
      const before = !after && nextKey ? anchorsByKey.get(nextKey) : null;
      const list = (after || before)?.parentElement;
      if (!list) continue;
      const ghost = element.cloneNode(true);
      stripIdentity(ghost);
      ghost.classList.add('motion-leaving');
      if (after) after.after(ghost); else before.before(ghost);
      anchorsByKey.set(key, ghost);
      const height = ghost.getBoundingClientRect().height;
      const gap = Number.parseFloat(windowRef.getComputedStyle(list).rowGap) || 0;
      // Fold the row and the gap it adds, so the rows below settle without a final jump.
      const controls = animateImpl(ghost, { opacity: [1, 0], height: [`${height}px`, '0px'], paddingTop: [null, '0px'], paddingBottom: [null, '0px'], borderTopWidth: [null, '0px'], borderBottomWidth: [null, '0px'], marginTop: ['0px', `-${gap}px`] }, { duration: DURATION.base, ease: EASE_OUT });
      Promise.resolve(controls).then(() => ghost.remove(), () => ghost.remove());
    }
  };

  const onContentMutations = records => {
    const section = content.firstElementChild;
    const page = pageKey(documentRef, windowRef.location);
    const pageChanged = page !== currentPage;
    currentPage = page;
    const rows = [...content.querySelectorAll(KEYED_ROW_SELECTOR)];
    const keys = new Set(rows.map(rowKey));
    if (pageChanged) {
      knownRows.clear();
      for (const key of keys) knownRows.add(key);
      progressValues.clear();
      if (section && !reduced()) enterPage(section);
      rememberProgress(content);
      return;
    }
    const added = rows.filter(row => !knownRows.has(rowKey(row)) && !row.closest('.motion-leaving'));
    for (const key of keys) knownRows.add(key);
    if (!reduced()) {
      enterRows(added);
      const removed = [];
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node.nodeType !== 1) continue;
          const candidates = node.matches?.(LEAVING_ROW_SELECTOR) ? [node] : [...node.querySelectorAll?.(LEAVING_ROW_SELECTOR) || []];
          candidates.forEach((element, index) => {
            const key = rowKey(element);
            if (!key || keys.has(key)) return;
            const previousKey = candidates.slice(0, index).reverse().map(rowKey).find(candidate => keys.has(candidate));
            const nextKey = candidates.slice(index + 1).map(rowKey).find(candidate => keys.has(candidate));
            removed.push({ element, key, previousKey, nextKey });
          });
        }
      }
      if (removed.length) leaveRows(removed, new Map(rows.map(row => [rowKey(row), row])));
    }
    for (const key of [...knownRows]) if (!keys.has(key)) knownRows.delete(key);
    rememberProgress(content);
  };

  const contentObserver = new MutationObserver(onContentMutations);
  contentObserver.observe(content, { childList: true, subtree: true });

  // Dialogs, the toast and the background-work count live outside the page content.
  const lastToastDisplay = { value: '' };
  const chromeObserver = new MutationObserver(records => {
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
          settle(animateImpl(count, { scale: [1.25, 1] }, { type: 'spring', bounce: 0.3, visualDuration: DURATION.base }), [count]);
          lastCount = shown;
        }
      }
    }
  });
  chromeObserver.observe(documentRef.body, { attributes: true, attributeFilter: ['open', 'style'], attributeOldValue: true, subtree: true });
  const count = documentRef.querySelector('#background-work-count');
  let lastCount = count?.textContent;
  if (count) chromeObserver.observe(count, { childList: true, characterData: true, subtree: true });

  return () => { contentObserver.disconnect(); chromeObserver.disconnect(); for (const { controls } of runningTweens.values()) controls.stop(); runningTweens.clear(); };
}

if (typeof document !== 'undefined' && document.querySelector('#workspace-content')) installWorkspaceMotion();
