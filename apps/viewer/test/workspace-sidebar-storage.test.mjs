import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkspaceSidebar, readNavCollapsed } from '../workspace-sidebar.mjs';

/** A minimal element: class list, attributes, click handler and nav links for the drawer focus. */
function element() {
  const classes = new Set(), attributes = new Map();
  return { classList: { toggle: (name, on) => { const next = on ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; }, contains: name => classes.has(name) },
    setAttribute: (name, value) => attributes.set(name, String(value)), getAttribute: name => attributes.get(name) ?? null,
    querySelector: () => null, onclick: null, attributes };
}
function withThrowingStorage(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } });
  try { return run(); } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage;
  }
}

test('a blocked localStorage getter neither throws nor stops the sidebar from installing or collapsing', () => withThrowingStorage(() => {
  assert.equal(readNavCollapsed(), false);
  const shell = element(), collapseButton = element(), container = element(), keys = [];
  let rerenders = 0;
  assert.doesNotThrow(() => installWorkspaceSidebar({ shell, collapseButton, container, rerender: () => { rerenders++; },
    documentRef: { addEventListener: (type) => keys.push(type) } }));
  assert.equal(shell.classList.contains('nav-collapsed'), false);
  assert.doesNotThrow(() => collapseButton.onclick());
  assert.equal(shell.classList.contains('nav-collapsed'), true, 'collapsing still works for this visit');
  assert.equal(rerenders, 1);
}));

test('a supplied storage is used as given, and a storage that throws on read or write falls back quietly', () => {
  const saved = new Map([['ltds.viewer.sidebar.collapsed', 'true']]);
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  assert.equal(readNavCollapsed(storage), true);
  const shell = element(), collapseButton = element();
  installWorkspaceSidebar({ shell, collapseButton, container: element(), rerender: () => {}, documentRef: { addEventListener() {} }, storage });
  assert.equal(shell.classList.contains('nav-collapsed'), true);
  collapseButton.onclick();
  assert.equal(saved.get('ltds.viewer.sidebar.collapsed'), 'false');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readNavCollapsed(broken), false);
  assert.equal(readNavCollapsed(null), false);
});
