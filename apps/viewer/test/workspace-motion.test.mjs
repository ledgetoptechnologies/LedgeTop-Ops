import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DURATION, installWorkspaceMotion, pageKey, prefersReducedMotion, progressKey, progressTween, rowKey } from '../workspace-motion.mjs';
import { workspaceMotionPlugin, WORKSPACE_MOTION_SCRIPT } from '../vite.config.mjs';

const element = (attributes = {}, parent = null) => ({
  getAttribute: name => attributes[name] ?? null,
  hasAttribute: name => name in attributes,
  closest: () => parent,
});

test('rows are identified by their stable data keys', () => {
  assert.equal(rowKey(element({ 'data-operation-id': 'op-1' })), 'data-operation-id=op-1');
  assert.equal(rowKey(element({ 'data-derivative-id': 'd-1' })), 'data-derivative-id=d-1');
  assert.equal(rowKey(element({})), '');
  assert.equal(rowKey(null), '');
});

test('progress bars keep identity across re-renders through their row and label', () => {
  const row = element({ 'data-operation-id': 'op-1' });
  assert.equal(progressKey(element({ 'aria-label': 'Import progress', value: '40' }, row)), 'data-operation-id=op-1|Import progress');
  assert.equal(progressKey(element({ value: '40' }, null)), '', 'unkeyed bars are not tweened');
});

test('only determinate bars that changed are tweened, and indeterminate bars never get a value', () => {
  const progress = element({ max: '100', value: '64' });
  assert.deepEqual(progressTween(42, progress), { from: 42, to: 64 });
  assert.deepEqual(progressTween(42, element({ value: '0.64' })), { from: 42, to: 64 });
  assert.equal(progressTween(64, progress), null);
  assert.equal(progressTween(undefined, progress), null, 'first render shows the value directly');
  assert.equal(progressTween(42, element({})), null, 'indeterminate bars stay indeterminate');
});

test('reduced motion is read from the media query and fails safe', () => {
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({ matchMedia() { throw new Error('unsupported'); } }), false);
  assert.equal(prefersReducedMotion(undefined), false);
});

test('page identity combines the section, task and title', () => {
  const doc = { querySelector: () => ({ textContent: 'Background work' }) };
  assert.equal(pageKey(doc, { href: 'https://viewer.test/workspace?section=background' }), 'background||Background work');
  assert.notEqual(pageKey(doc, { href: 'https://viewer.test/workspace?section=background' }), pageKey(doc, { href: 'https://viewer.test/workspace?section=trash' }));
});

test('UI transitions stay short', () => {
  assert.ok(DURATION.fast >= 0.15 && DURATION.base <= 0.3);
});

test('the build loads the motion module on the workspace page only', () => {
  const { handler } = workspaceMotionPlugin().transformIndexHtml;
  const page = '<html><body><main></main></body></html>';
  assert.ok(handler(page, { filename: '/repo/apps/viewer/workspace.html' }).includes(WORKSPACE_MOTION_SCRIPT));
  assert.equal(handler(page, { filename: '/repo/apps/viewer/index.html' }), page);
  const once = handler(page, { filename: 'C:\\repo\\apps\\viewer\\workspace.html' });
  assert.equal(handler(once, { filename: 'C:\\repo\\apps\\viewer\\workspace.html' }), once, 'never injected twice');
});

test('workspace progress bars and the background indicator respect reduced motion', () => {
  const css = readFileSync(new URL('../workspace-transfers.css', import.meta.url), 'utf8');
  assert.match(css, /progress:indeterminate/);
  const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
  assert.match(reduced, /progress:indeterminate[^{]*\{animation:none/);
  assert.match(reduced, /has-active>span\[aria-hidden\]\{animation:none/);
  for (const file of ['index.html', 'public/pointcloud.html', 'review-launch.html']) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(html, /prefers-reduced-motion:[^)]*reduce\)[\s\S]*?(?:\.spinner|\.dot)[^{]*\{\s*animation:\s*none/);
  }
});

const inlineStyle = () => {
  const values = new Map();
  return {
    getPropertyValue: name => values.get(name)?.value ?? '',
    getPropertyPriority: name => values.get(name)?.priority ?? '',
    setProperty: (name, value, priority = '') => values.set(name, { value, priority }),
    removeProperty: name => values.delete(name),
  };
};

test('Viewer loading paints only numeric percentages and clears stale fill', () => {
  const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const bar = { style: inlineStyle() };
  const dom = { loadingOverlay: { classList: { add() {}, remove() {} } }, loadingText: {}, loadingProgress: {}, loadingCancel: { style: {} } };
  const script = source.slice(source.indexOf('function updateLoading('), source.indexOf('let errorHideTimer'));
  const { updateLoading, hideLoading } = runInNewContext(script + '\n({ updateLoading, hideLoading })',
    { document: { getElementById: () => bar }, dom });
  for (const [value, fraction] of [['42%', '0.42'], [' 12.5% ', '0.125'], ['150%', '1']]) {
    updateLoading('Loading', value);
    assert.equal(bar.hidden, false);
    assert.equal(bar.style.getPropertyValue('--loading-fraction'), fraction);
    assert.equal(dom.loadingProgress.textContent, value);
  }
  updateLoading('Preparing model', '12x5%');
  assert.equal(bar.hidden, true);
  assert.equal(bar.style.getPropertyValue('--loading-fraction'), '');
  updateLoading('Loading', '50%');
  hideLoading();
  assert.equal(bar.hidden, true);
  assert.equal(bar.style.getPropertyValue('--loading-fraction'), '');
});

function motionFixture() {
  const observers = [];
  const effects = [];
  const listeners = new Map();
  const preference = {
    matches: false,
    addEventListener: (_name, listener) => { preference.change = listener; },
    removeEventListener: () => { delete preference.change; },
  };
  const content = {
    rows: [], progress: [], firstElementChild: null,
    querySelectorAll(selector) { return selector === 'progress' ? this.progress : this.rows; },
  };
  const location = { href: 'https://viewer.test/workspace?section=background' };
  const stop = installWorkspaceMotion({
    documentRef: { body: {}, querySelector: () => null },
    windowRef: {
      location, matchMedia: () => preference, getComputedStyle: () => ({ rowGap: '6px' }),
      MutationObserver: class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
      },
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: name => listeners.delete(name),
    },
    content,
    animateImpl(target, to, options) {
      const effect = { target, to, options, stopped: false };
      // Keep the control active until the fixture explicitly tears down the effect.
      const controls = Object.assign(new Promise(() => {}), { stop: () => { effect.stopped = true; } });
      effects.push(effect);
      return controls;
    },
  });
  return { content, observers, effects, listeners, preference, location, stop,
    render: records => observers[0].callback(records) };
}

function operationRow(id, list = {}) {
  return {
    ...element({ 'data-operation-id': id }), style: inlineStyle(), isConnected: true, parentElement: list,
    matches: () => true,
    after: ghost => { list.ghost = ghost; ghost.parentElement = list; },
    before: ghost => { list.ghost = ghost; ghost.parentElement = list; },
    cloneNode: () => ({
      querySelectorAll: () => [], attributes: [], setAttribute() {}, classList: new Set(),
      getBoundingClientRect: () => ({ height: 44 }), remove() { list.ghost = null; },
    }),
  };
}

test('visual progress and row exits stop when reduced motion changes or the page leaves', () => {
  const fixture = motionFixture();
  const list = {};
  const prior = operationRow('old', list), anchor = operationRow('remaining', list);
  const attributes = { max: '100', value: '40' };
  const classes = new Set();
  const progress = {
    ...element(attributes, anchor), style: inlineStyle(), isConnected: true,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    set value(_) { assert.fail('the native progress value must stay authoritative'); },
  };
  fixture.content.rows = [prior, anchor];
  fixture.content.progress = [progress];
  fixture.render();
  fixture.content.rows = [anchor];
  prior.isConnected = false;
  attributes.value = '64';
  fixture.render();
  const ghost = list.ghost;
  const exit = fixture.effects.find(effect => effect.target === ghost);
  const tween = fixture.effects.at(-1);
  assert.ok(exit);
  assert.equal(attributes.value, '64');
  assert.equal(progress.style.getPropertyValue('--motion-progress'), '40%');
  tween.options.onUpdate(55);
  assert.equal(progress.style.getPropertyValue('--motion-progress'), '55%');

  fixture.preference.matches = true;
  fixture.preference.change(fixture.preference);
  assert.equal(list.ghost, null);
  assert.equal(exit.stopped, true);
  assert.equal(tween.stopped, true);
  assert.equal(progress.style.getPropertyValue('--motion-progress'), '');
  assert.equal(classes.size, 0);
  tween.options.onUpdate(60);
  assert.equal(progress.style.getPropertyValue('--motion-progress'), '', 'late frames cannot repaint');
  assert.equal(attributes.value, '64');

  fixture.preference.matches = false;
  const entrance = operationRow('new', list);
  entrance.style.setProperty('opacity', '.8');
  fixture.content.rows = [anchor, entrance];
  fixture.render();
  const motion = fixture.effects.at(-1);
  entrance.style.setProperty('opacity', '.2');
  entrance.style.setProperty('transform', 'translateY(-4px)');
  fixture.location.href = 'https://viewer.test/workspace?section=trash';
  fixture.render();
  assert.equal(motion.stopped, true);
  assert.equal(entrance.style.getPropertyValue('opacity'), '.8');
  assert.equal(entrance.style.getPropertyValue('transform'), '');
  fixture.stop();
  assert.ok(fixture.observers.every(observer => observer.disconnected));
  assert.equal(fixture.listeners.size, 0);
  assert.equal(fixture.preference.change, undefined);
});

test('View all limits entrances and never walks large removed subtrees', () => {
  const fixture = motionFixture();
  const anchor = operationRow('remaining');
  fixture.content.rows = [anchor, ...Array.from({ length: 1000 }, (_, i) => operationRow(`item-${i}`))];
  fixture.render();
  assert.equal(fixture.effects.length, 8);
  for (const row of fixture.content.rows.slice(1)) row.isConnected = false;
  fixture.content.rows = [anchor];
  fixture.render([{ get removedNodes() { assert.fail('bulk removed DOM must not be enumerated'); } }]);
  assert.equal(fixture.effects.length, 8, 'bulk removal creates no ghost animations');
  assert.ok(fixture.effects.filter(effect => effect.target !== anchor).every(effect => effect.stopped));
  fixture.stop();
  assert.ok(fixture.effects.every(effect => effect.stopped));
});
