import test from 'node:test';
import assert from 'node:assert/strict';
import { bindProjectSwitcherNavigation, renderProjectSwitcherOptions } from '../project-switcher.mjs';

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

test('project task switch retains temporary marks on Stay and discards only on Leave', async () => {
  let pending = true;
  const visits = [], opened = [];
  const make = () => Object.assign(new EventTarget(), { focus() {}, setAttribute() {} });
  const select = make();
  const documentRef = { body: { append(dialog) { opened.push(dialog); } },
    createElement() {
      const dialog = make(), pieces = new Map();
      for (const key of ['[data-stay]', '[data-leave]', '#staff-leave-description']) pieces.set(key, make());
      dialog.querySelector = key => pieces.get(key);
      dialog.showModal = () => {};
      dialog.remove = () => {};
      return dialog;
    },
  };
  const source = 'https://viewer.example/project/synthetic?task=a&mode=ortho';
  const unbind = bindProjectSwitcherNavigation(select, {
    queryKey: 'task', currentUrl: () => source, navigate: href => visits.push(href),
    hasTemporaryMarks: () => pending, discardTemporaryMarks: () => { pending = false; },
    hasUnfinishedMeasurements: () => false, documentRef,
  });
  const change = () => { select.value = 'b'; select.dispatchEvent(new Event('change')); };
  const choose = (button) => opened.at(-1).querySelector(button).dispatchEvent(new Event('click'));
  change();
  assert.equal(select.value, 'a');
  assert.match(opened[0].querySelector('#staff-leave-description').textContent, /temporary marks/);
  choose('[data-stay]');
  assert.equal(pending, true);
  assert.deepEqual(visits, []);
  change();
  choose('[data-leave]');
  assert.equal(pending, false);
  assert.deepEqual(visits, ['https://viewer.example/project/synthetic?task=b&mode=ortho']);
  unbind();
});
