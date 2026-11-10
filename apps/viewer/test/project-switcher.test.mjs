import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectSwitcherOptions } from '../project-switcher.mjs';

// A minimal DOM: options keep text and value as plain properties, the way the browser does.
function fakeSelect() {
  const doc = { createElement: (tag) => ({ tag, value: '', textContent: '' }) };
  const select = { ownerDocument: doc, children: [], innerHTML: '', replaceChildren(...nodes) { this.children = nodes; } };
  Object.defineProperty(select, 'value', { get() { return this.children[0]?.value ?? ''; } });
  return select;
}

test('task titles with HTML characters are shown as text, never parsed', () => {
  const select = fakeSelect();
  const title = 'Site <img src=x onerror=alert(1)> & "North" </option></select>';
  renderProjectSwitcherOptions(select, [{ id: 'task-1', title }, { id: 'task "2"', title: 'Second <b>pass</b>' }]);
  assert.equal(select.innerHTML, '', 'nothing is written as markup');
  assert.equal(select.children.length, 2);
  assert.deepEqual(select.children.map((o) => o.tag), ['option', 'option']);
  assert.equal(select.children[0].textContent, title);
  assert.equal(select.children[1].value, 'task "2"');
  assert.equal(select.children[1].textContent, 'Second <b>pass</b>');
});

test('the first task stays selected and re-rendering replaces the options', () => {
  const select = fakeSelect();
  renderProjectSwitcherOptions(select, [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
  assert.equal(select.value, 'a');
  renderProjectSwitcherOptions(select, [{ id: 'c', title: 'C' }]);
  assert.deepEqual(select.children.map((o) => o.value), ['c']);
  renderProjectSwitcherOptions(select, [{ id: 7, title: null }]);
  assert.equal(select.children[0].value, '7');
  assert.equal(select.children[0].textContent, '');
});
