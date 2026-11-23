'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'workspace-projects.js'), 'utf8');
const take = (start, end) => {
  const at = source.indexOf(start), stop = source.indexOf(end, at);
  assert.ok(at >= 0 && stop > at, `missing shipped source ${start}`);
  return source.slice(at, stop);
};
const line = start => source.split(/\r?\n/).find(value => value.startsWith(start));
const settle = () => new Promise(resolve => setImmediate(resolve));

const PROJECTS = [
  { id: 'p', displayName: 'Harbor', status: 'active' }, { id: 'q', displayName: 'Quarry', status: 'active' }, { id: 'old', displayName: 'Old', status: 'archived' },
];
const FOLDERS = {
  p: [{ id: 'site', projectId: 'p', parentId: null, displayName: 'Site' }, { id: 'maps', projectId: 'p', parentId: 'site', displayName: 'Maps' }],
  q: [{ id: 'quarry-maps', projectId: 'q', parentId: null, displayName: 'Quarry maps' }],
};

// A <select> stand-in: options come from its markup, one is chosen, and it can have nothing chosen.
function picker() {
  const element = {
    options: [], selectedIndex: -1, disabled: false, onchange: null,
    set innerHTML(html) {
      this.options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map(([, value, attributes, textContent]) => ({ value, textContent, selected: /\bselected\b/.test(attributes) }));
      this.selectedIndex = Math.max(0, this.options.findIndex(option => option.selected));
    },
    get value() { return this.options[this.selectedIndex]?.value ?? ''; },
    get selectedOptions() { return this.selectedIndex < 0 ? [] : [this.options[this.selectedIndex]]; },
    choose(value) { this.selectedIndex = this.options.findIndex(option => option.value === value); this.onchange?.({ currentTarget: this }); },
  };
  return element;
}

function dialog({ cached = ['p'], permissions = null, respond = null } = {}) {
  const calls = [], toasts = [], operations = [];
  const node = extra => ({ hidden: false, textContent: '', innerHTML: '', classList: { values: new Set(), toggle(name, on) { on ? this.values.add(name) : this.values.delete(name); } }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, ...extra });
  const submit = node({ disabled: true }), status = node({ hidden: true }), browser = node(), heading = node(), selection = node();
  const form = { isConnected: true, elements: { projectId: picker(), folderId: picker(), sourceRelativePath: { value: '', dataset: {} }, taskDisplayName: { value: 'Map' } } };
  submit.form = form;
  form.querySelector = selector => ({ 'button[type="submit"]': submit, '[data-import-folder-status]': status, '#server-import-browser': browser })[selector];
  const upload = { elements: { datasetId: { value: '', innerHTML: '' } } };
  const tabs = ['device', 'server'].map(name => node({ dataset: { importTab: name } })), panels = ['device', 'server'].map(name => node({ dataset: { importPanel: name } }));
  const ui = { title: null, body: null, opened: 0, browsed: 0, closed: 0, form, upload, submit, status, browser, heading, tabs, panels, calls, toasts, operations };
  const context = {
    state: { token: 'token', busy: false, projects: PROJECTS, datasets: [{ id: 'draft', projectId: 'p', status: 'draft', displayName: 'Draft' }, { id: 'q-draft', projectId: 'q', status: 'draft', displayName: 'Quarry draft' }] },
    can: permission => !permissions || permissions.includes(permission),
    folderCache: new Map(cached.map(id => [id, { folders: FOLDERS[id] }])),
    openModal: (title, body) => {
      ui.title = title; ui.body = body; ui.opened++;
      form.elements.projectId.innerHTML = body.slice(body.indexOf('name="projectId"'), body.indexOf('name="folderId"'));
      form.elements.folderId.innerHTML = body.slice(body.indexOf('name="folderId"'), body.indexOf('data-import-folder-status'));
      upload.elements.datasetId.innerHTML = body;
    },
    modal: { close: () => { ui.closed++; } },
    modalContent: {
      querySelector: selector => ({ '#upload-form': upload, '#server-import-form': form, '#workspace-modal-title': heading, '#server-import-browser': browser, '#server-import-selection': selection })[selector],
      querySelectorAll: selector => (selector === '[data-import-tab]' ? tabs : selector === '[data-import-panel]' ? panels : []),
    },
    renderServerImportBrowser: () => { ui.browsed++; },
    uploadFiles: () => {},
    values: value => ({ projectId: value.elements.projectId.value, folderId: value.elements.folderId.value, sourceRelativePath: value.elements.sourceRelativePath.value, taskDisplayName: value.elements.taskDisplayName.value }),
    api: async (url, options = {}) => {
      calls.push([url, options]);
      const answered = await respond?.(url, options);
      if (answered) return answered;
      const listed = /^\/api\/v1\/projects\/([^/]+)\/folders$/.exec(url);
      return listed ? { folders: FOLDERS[listed[1]] } : { operation: { id: 'operation' } };
    },
    crypto: { randomUUID: () => 'key' },
    rememberOperation: operation => operations.push(operation), scheduleOperationRefresh: () => {}, toast: (message, bad = false) => toasts.push([message, bad]),
  };
  vm.createContext(context);
  vm.runInContext([
    line('const esc='), line('const opts='), line('const field='), line('const select='), line('function canImportInto('),
    take('function folderPath(', '\nconst content='), take('function folderPickerOptions(', '\nfunction phoneLayout('),
    take('function importModal(', '\nlet activeNewTask='), take('async function submitServerImport(', '\nmodalContent.addEventListener('),
  ].join('\n'), context);
  ui.context = context;
  ui.choose = (value = 'incoming/map', kind = 'folder') => { form.elements.sourceRelativePath.value = value; form.elements.sourceRelativePath.dataset.sourceKind = kind; context.syncImportSubmit(form); };
  ui.target = () => [form.elements.projectId.value, form.elements.folderId.selectedOptions[0]?.textContent ?? null];
  return ui;
}

test('from a folder the dialog opens on the server import with that project and folder filled in', async () => {
  const ui = dialog();
  ui.context.importModal('p', null, 'maps');
  await settle();
  assert.equal(ui.title, 'Import into Harbor');
  assert.deepEqual(ui.target(), ['p', 'Site / Maps']);
  assert.deepEqual(ui.panels.map(panel => panel.hidden), [true, false]);
  assert.deepEqual(ui.tabs.map(tab => tab.attributes['aria-selected']), ['false', 'true']);
  assert.equal(ui.browsed, 1);
  // Only active projects are offered, and the current project's folders plus its root.
  assert.deepEqual(ui.form.elements.projectId.options.map(option => option.value), ['p', 'q']);
  assert.deepEqual(ui.form.elements.folderId.options.map(option => option.textContent), ['Project root', 'Site', 'Site / Maps']);
  assert.equal(ui.submit.disabled, true, 'nothing is queued until a source is chosen');
  ui.choose();
  assert.equal(ui.submit.disabled, false);
  await ui.context.submitServerImport(ui.form);
  const [url, options] = ui.calls.at(-1);
  assert.equal(url, '/api/v1/processing/server-task-imports');
  assert.deepEqual({ ...options.body }, { projectId: 'p', folderId: 'maps', sourceRelativePath: 'incoming/map', taskDisplayName: 'Map' });
  assert.deepEqual(ui.toasts, [['Import queued for Site / Maps; progress will continue in Background work', false]]);
  assert.equal(ui.closed, 1);
});

test('from the project the target is its root and the request is the one root imports always sent', async () => {
  const ui = dialog();
  ui.context.importModal('p', null);
  await settle();
  assert.deepEqual(ui.target(), ['p', 'Project root']);
  ui.choose('incoming/map.zip', 'zip');
  await ui.context.submitServerImport(ui.form);
  const [url, options] = ui.calls.at(-1);
  assert.equal(url, '/api/v1/processing/webodm-task-imports');
  assert.deepEqual({ ...options.body }, { projectId: 'p', sourceRelativePath: 'incoming/map.zip', taskDisplayName: 'Map' });
  assert.deepEqual(ui.toasts, [['Import queued; progress will continue in Background work', false]]);
});

test('the target can change to another project, which reloads its folders and starts at its root', async () => {
  const ui = dialog();
  ui.context.importModal('p', null, 'maps');
  ui.choose();
  ui.form.elements.projectId.choose('q');
  // Until the other project's folders are known nothing can be queued.
  assert.equal(ui.form.elements.folderId.disabled, true);
  assert.equal(ui.submit.disabled, true);
  await ui.context.submitServerImport(ui.form);
  assert.equal(ui.calls.some(([url]) => url.includes('imports')), false);
  await settle();
  assert.equal(ui.heading.textContent, 'Import into Quarry');
  assert.match(ui.upload.elements.datasetId.innerHTML, /Quarry draft/);
  assert.deepEqual(ui.form.elements.folderId.options.map(option => option.textContent), ['Project root', 'Quarry maps']);
  assert.deepEqual(ui.target(), ['q', 'Project root']);
  assert.equal(ui.submit.disabled, false);
  ui.form.elements.folderId.choose('quarry-maps');
  await ui.context.submitServerImport(ui.form);
  assert.deepEqual({ ...ui.calls.at(-1)[1].body }, { projectId: 'q', folderId: 'quarry-maps', sourceRelativePath: 'incoming/map', taskDisplayName: 'Map' });
});

test('a late folder list never fills in for a project the user has left', async () => {
  let release;
  const ui = dialog({ respond: url => (url.includes('/projects/q/') ? new Promise(resolve => { release = () => resolve({ folders: FOLDERS.q }); }) : null) });
  ui.context.importModal('p', null, 'maps');
  ui.form.elements.projectId.choose('q');
  ui.form.elements.projectId.choose('p');
  release();
  await settle();
  assert.deepEqual(ui.form.elements.folderId.options.map(option => option.value), ['', 'site', 'maps']);
  assert.deepEqual(ui.target(), ['p', 'Project root']);
});

test('a folder that is gone leaves nothing chosen instead of falling back to the root', async () => {
  const ui = dialog({ respond: (url, options) => {
    if (options.method === 'POST') throw Object.assign(new Error('The folder is no longer in this project.'), { code: 'invalid_folder' });
    return { folders: FOLDERS.p.filter(folder => folder.id === 'site') };
  } });
  ui.context.importModal('p', null, 'maps');
  ui.choose();
  await ui.context.submitServerImport(ui.form);
  await settle();
  assert.equal(ui.closed, 0);
  assert.deepEqual(ui.toasts, [['The folder is no longer in this project.', true]]);
  assert.deepEqual(ui.target(), ['p', null]);
  assert.equal(ui.status.hidden, false);
  assert.equal(ui.status.textContent, 'That folder is no longer in this project. Choose another folder.');
  assert.equal(ui.submit.disabled, true);
  assert.equal(ui.browser.innerHTML, '', 'the chosen source stays on screen');
  const before = ui.calls.length;
  await ui.context.submitServerImport(ui.form);
  assert.equal(ui.calls.length, before);
  ui.form.elements.folderId.choose('site');
  assert.equal(ui.submit.disabled, false);
});

// A POST whose answer the test releases when it wants.
function pendingImport() {
  const answer = {};
  const ui = dialog({ cached: ['p', 'q'], respond: (url, options) => (options.method === 'POST' ? new Promise((resolve, reject) => { answer.resolve = () => resolve({ operation: { id: 'operation' } }); answer.reject = (message, code) => reject(Object.assign(new Error(message), code ? { code } : {})); }) : null) });
  ui.context.importModal('p', null, 'maps');
  ui.choose();
  return { ui, answer, sent: ui.context.submitServerImport(ui.form) };
}

test('the target is held while the import is being sent and given back when it is refused', async () => {
  const { ui, answer, sent } = pendingImport(), { projectId, folderId } = ui.form.elements;
  assert.deepEqual([projectId.disabled, folderId.disabled, ui.submit.disabled], [true, true, true]);
  assert.deepEqual({ ...ui.calls.at(-1)[1].body }, { projectId: 'p', folderId: 'maps', sourceRelativePath: 'incoming/map', taskDisplayName: 'Map' });
  // Choosing another source meanwhile does not make the form sendable.
  ui.choose('incoming/other');
  assert.equal(ui.submit.disabled, true);
  answer.reject('busy');
  await sent;
  assert.deepEqual([projectId.disabled, folderId.disabled, ui.submit.disabled], [false, false, false]);
  assert.deepEqual(ui.target(), ['p', 'Site / Maps']);
  assert.match(ui.browser.innerHTML, /busy/);
});

test('a late folder refusal never replaces a newer target', async () => {
  const { ui, answer, sent } = pendingImport();
  ui.form.elements.projectId.choose('q');
  ui.form.elements.folderId.choose('quarry-maps');
  const before = ui.calls.length;
  answer.reject('The folder is no longer in this project.', 'invalid_folder');
  await sent;
  await settle();
  assert.deepEqual(ui.target(), ['q', 'Quarry maps']);
  assert.equal(ui.calls.length, before, 'the newer project is not reloaded with the old folder');
  assert.equal(ui.status.hidden, true);
  assert.equal(ui.submit.disabled, false);
  assert.deepEqual(ui.toasts, [['The folder is no longer in this project.', true]]);
});

test('an unfinished folder list stays in charge of the folder field after a late refusal', async () => {
  const { ui, answer, sent } = pendingImport();
  ui.context.folderCache.delete('q');
  let release;
  ui.context.api = () => new Promise(resolve => { release = () => resolve({ folders: FOLDERS.q }); });
  ui.form.elements.projectId.choose('q');
  answer.reject('The folder is no longer in this project.', 'invalid_folder');
  await sent;
  assert.deepEqual([ui.form.elements.folderId.disabled, ui.submit.disabled], [true, true]);
  release();
  await settle();
  assert.deepEqual(ui.form.elements.folderId.options.map(option => option.value), ['', 'quarry-maps']);
  assert.deepEqual([ui.form.elements.folderId.disabled, ui.submit.disabled], [false, false]);
});

test('an answer for a replaced dialog leaves the new one alone', async () => {
  for (const outcome of ['queued', 'invalid_folder', 'failed']) {
    const { ui, answer, sent } = pendingImport();
    ui.form.isConnected = false;
    ui.browser.innerHTML = 'new dialog';
    const before = [ui.calls.length, ui.submit.textContent];
    if (outcome === 'queued') answer.resolve(); else answer.reject('refused', outcome === 'failed' ? undefined : outcome);
    await sent;
    await settle();
    assert.equal(ui.closed, 0, outcome);
    assert.equal(ui.browser.innerHTML, 'new dialog', outcome);
    assert.deepEqual([ui.calls.length, ui.submit.textContent], before, outcome);
    assert.equal(ui.toasts.length, 1, 'the result is still announced');
    assert.equal(ui.operations.length, outcome === 'queued' ? 1 : 0);
    assert.equal(ui.context.state.busy, false);
  }
});

test('when folders cannot load, the root stays available and says why', async () => {
  const ui = dialog({ cached: [], respond: () => { throw new Error('offline'); } });
  ui.context.importModal('p', null);
  await settle();
  assert.deepEqual(ui.target(), ['p', 'Project root']);
  assert.match(ui.status.textContent, /Folders could not be loaded \(offline\)/);
  ui.choose();
  assert.equal(ui.submit.disabled, false);
});

test('the dialog needs an active project and the import permission; draft uploads open as before', async () => {
  const denied = dialog({ permissions: ['viewer.projects.write', 'viewer.datasets.write'] });
  denied.context.importModal('p', null, 'maps');
  assert.equal(denied.opened, 0);
  denied.context.importModal(null, 'draft');
  assert.equal(denied.opened, 1);
  assert.equal(denied.upload.elements.datasetId.value, 'draft');
  assert.deepEqual(denied.panels.map(panel => panel.hidden), [false, true]);
  assert.deepEqual([denied.browsed, denied.calls.length], [0, 0]);
  const archived = dialog();
  archived.context.importModal('old', null);
  archived.context.importModal('missing', null);
  assert.equal(archived.opened, 0);
});

test('menu items route to the dialog with their own target', async () => {
  const opened = [];
  const context = { importModal: (...args) => opened.push(args) };
  vm.createContext(context);
  vm.runInContext(take('async function action(element){', "\n  if(action==='project-process')") + '\n}', context);
  const element = (action, id, dataset = {}) => ({ dataset: { action, id, ...dataset }, getAttribute: () => null });
  await context.action(element('project-import', 'p'));
  await context.action(element('folder-import', 'maps', { projectId: 'p' }));
  await context.action(element('upload-dataset', 'draft'));
  assert.deepEqual(opened, [['p', null], ['p', null, 'maps'], [null, 'draft']]);
});

test('folder menus offer the import by its own permission, as a keyboard menu item', () => {
  const start = source.indexOf('function menuItem('), end = source.indexOf('\nfunction newFolderTreeRow(', start);
  const context = {
    can: null, treeRenaming: null, TREE_ICONS: {}, treeIcon: () => '', folderIsEmpty: () => false, countLabel: () => '1 task',
  };
  vm.createContext(context);
  vm.runInContext([line('const esc='), source.slice(start, end)].join('\n'), context);
  const row = { key: 'f:maps', level: 3, posinset: 1, setsize: 1, parentKey: 'f:site', expanded: false, folder: FOLDERS.p[1] };
  const menu = (project, permissions) => {
    context.can = permission => permissions.includes(permission);
    const html = context.folderTreeRow(row, project, FOLDERS.p, [], new Map());
    return [...html.matchAll(/role="menuitem" tabindex="-1" data-action="([^"]+)"/g)].map(match => match[1]);
  };
  assert.deepEqual(menu(PROJECTS[0], ['viewer.projects.write', 'viewer.datasets.import']), ['folder-new', 'folder-import', 'folder-rename', 'folder-delete']);
  assert.deepEqual(menu(PROJECTS[0], ['viewer.projects.write']), ['folder-new', 'folder-rename', 'folder-delete']);
  assert.deepEqual(menu(PROJECTS[0], ['viewer.datasets.import']), ['folder-import']);
  assert.deepEqual(menu(PROJECTS[0], []), []);
  assert.deepEqual(menu(PROJECTS[2], ['viewer.projects.write', 'viewer.datasets.import']), [], 'archived projects are read-only');
  context.can = () => true;
  assert.match(context.folderTreeRow(row, PROJECTS[0], FOLDERS.p, [], new Map()), /data-action="folder-import" data-id="maps"  data-project-id="p">Import existing map…</);
});

function contextMenus({ phone = false, open = ['p'] } = {}) {
  const opened = [], closed = [], toggled = [];
  const panel = { attributes: new Map(), style: {}, hasAttribute(name) { return this.attributes.has(name); }, removeAttribute(name) { this.attributes.delete(name); }, set popover(value) { this.attributes.set('popover', value); }, showPopover() { this.shown = (this.shown || 0) + 1; }, getBoundingClientRect: () => ({ width: 200, height: 160 }) };
  const item = { focus(options) { opened.push(options); } };
  const menu = { open: false, closest: () => null, querySelector: selector => (selector === ':scope > .project-more-menu' ? panel : item) };
  const row = (key, menus) => ({ dataset: { treeKey: key }, querySelectorAll: () => menus });
  const rows = { 'p:p': row('p:p', [menu]), 'f:maps': row('f:maps', [menu]), 'p:q': row('p:q', []), 'p:old': row('p:old', []) };
  const context = {
    state: { projects: PROJECTS }, innerWidth: 1000, innerHeight: 600, phoneLayout: () => phone,
    closeTreeMenus: except => closed.push(except ?? null), isProjectOpen: id => open.includes(id), treeRowElement: key => rows[key],
    toggleTreeProject: (id, value) => { toggled.push([id, value]); rows['p:q'] = row('p:q', [menu]); },
  };
  vm.createContext(context);
  vm.runInContext(take('function treeRowMenu(', '\nfunction treeMenuKeys('), context);
  const event = (key, { inside = null, shiftKey = false, x = 100, y = 50 } = {}) => ({
    shiftKey, clientX: x, clientY: y, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
    target: { closest: selector => (selector === 'details.tree-menu' ? (inside === 'menu' ? menu : null) : selector.includes('[data-tree-key]') ? rows[key] || null : inside === 'control' ? {} : null) },
  });
  return { context, panel, menu, opened, closed, toggled, event, rows };
}

test('right-click on a project or folder opens its own menu at the pointer, focused for the keyboard', () => {
  for (const key of ['p:p', 'f:maps']) {
    const ui = contextMenus(), event = ui.event(key);
    ui.context.treeContextMenu(event);
    assert.equal(event.defaultPrevented, true, key);
    assert.equal(ui.menu.open, true);
    assert.deepEqual([ui.panel.style.left, ui.panel.style.top], ['100px', '50px']);
    assert.equal(ui.opened.length, 1);
    // A second right-click moves the open menu, and one near the edge stays on screen.
    ui.context.treeContextMenu(ui.event(key, { x: 990, y: 590 }));
    assert.deepEqual([ui.panel.style.left, ui.panel.style.top], ['792px', '432px']);
    assert.equal(ui.panel.shown, 1);
  }
});

test('right-click on a closed active project opens it first; other places keep the browser menu', () => {
  const closedProject = contextMenus(), event = closedProject.event('p:q');
  closedProject.context.treeContextMenu(event);
  assert.deepEqual(closedProject.toggled, [['q', true]]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(closedProject.menu.open, true);
  const ui = contextMenus();
  for (const native of [ui.event('p:old'), ui.event('nowhere'), ui.event('p:p', { inside: 'control' }), ui.event('p:p', { shiftKey: true })]) {
    ui.context.treeContextMenu(native);
    assert.equal(native.defaultPrevented, false);
  }
  assert.deepEqual([ui.toggled, ui.menu.open], [[], false]);
  // The Menu key's own event on the open menu must not raise the browser's menu over it.
  const menuKey = ui.event('p:p', { inside: 'menu' });
  ui.context.treeContextMenu(menuKey);
  assert.equal(menuKey.defaultPrevented, true);
  assert.equal(ui.menu.open, false);
});

test('on a phone a long press opens the sheet, not a menu at the pointer', () => {
  const ui = contextMenus({ phone: true });
  ui.context.treeContextMenu(ui.event('f:maps'));
  assert.equal(ui.menu.open, true);
  assert.equal(ui.panel.shown, undefined);
  assert.deepEqual(ui.panel.style, {});
});

test('closing a menu that opened at the pointer puts it back at its button', () => {
  assert.match(source, /else if\(panel\?\.hasAttribute\('popover'\)\)\{try\{panel\.hidePopover\(\);\}catch\{\}panel\.removeAttribute\('popover'\);panel\.removeAttribute\('style'\);\}/);
  assert.match(source, /content\.addEventListener\('contextmenu',treeContextMenu\);/);
});
