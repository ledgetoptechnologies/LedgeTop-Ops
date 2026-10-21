import test from 'node:test';
import assert from 'node:assert/strict';
import { synchronizeOrthophotoPreviews } from '../workspace-orthophoto-preview-state.mjs';

function canvas(outputId) {
  const figure = { className: 'task-ortho-preview loading', innerHTML: '' };
  return {
    dataset: { orthoOutputId: outputId }, figure,
    ownerDocument: { createElement: tag => ({ tag }) },
    closest: () => figure,
    replaceWith(image) { this.replacement = image; },
  };
}
const container = canvases => ({ querySelectorAll: () => canvases });

test('decoded result reaches replacement and duplicate mounted canvases, not the detached original or another output', () => {
  const detached = canvas('output-one'), first = canvas('output-one'), second = canvas('output-one'), other = canvas('output-two');
  const preview = { status: 'ready', dataUrl: 'data:image/png;base64,cGl4ZWxz' };
  assert.equal(synchronizeOrthophotoPreviews(container([first, second, other]), 'output-one', preview), 2);
  for (const item of [first, second]) {
    assert.deepEqual(item.replacement, { tag: 'img', src: preview.dataUrl, alt: 'Published orthophoto preview' });
    assert.equal(item.figure.className, 'task-ortho-preview');
  }
  assert.equal(detached.replacement, undefined);
  assert.equal(other.replacement, undefined);
});

test('failed result updates the currently mounted preview with bounded safe fallback', () => {
  const current = canvas('output-one'), other = canvas('output-two');
  assert.equal(synchronizeOrthophotoPreviews(container([current, other]), 'output-one', { status: 'failed', message: '<script>untrusted</script>' }), 1);
  assert.equal(current.figure.className, 'task-ortho-preview unavailable');
  assert.match(current.figure.innerHTML, /aria-label="Orthophoto preview unavailable"/);
  assert.equal(current.figure.innerHTML.includes('untrusted'), false);
  assert.equal(other.figure.innerHTML, '');
});

test('pending results, invalid images, absent panels and orphan canvases cannot replace content', () => {
  const current = canvas('output-one');
  for (const preview of [{ status: 'loading' }, { status: 'ready', dataUrl: 'https://invalid.example/image.png' }, { status: 'ready', dataUrl: 12 }, null]) {
    assert.equal(synchronizeOrthophotoPreviews(container([current]), 'output-one', preview), 0);
    assert.equal(current.replacement, undefined);
  }
  assert.equal(synchronizeOrthophotoPreviews(null, 'output-one', { status: 'failed' }), 0);
  current.closest = () => null;
  assert.equal(synchronizeOrthophotoPreviews(container([current]), 'output-one', { status: 'failed' }), 0);
});
