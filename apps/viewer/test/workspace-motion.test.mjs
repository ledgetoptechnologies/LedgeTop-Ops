import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DURATION, pageKey, prefersReducedMotion, progressKey, progressTween, rowKey } from '../workspace-motion.mjs';
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
  assert.deepEqual(progressTween(42, element({ value: '64' })), { from: 42, to: 64 });
  assert.equal(progressTween(64, element({ value: '64' })), null);
  assert.equal(progressTween(undefined, element({ value: '64' })), null, 'first render shows the value directly');
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
});
