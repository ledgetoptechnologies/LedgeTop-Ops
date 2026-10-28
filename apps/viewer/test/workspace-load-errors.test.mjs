import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../workspace-projects.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const line = name => {
  const found = source.split('\n').find(text => text.startsWith(name));
  assert.ok(found, `missing one-line declaration ${name}`);
  return found;
};

function harness({ failing = new Set(), previous = {} } = {}) {
  const fixtures = {
    '/api/v1/projects': { projects: [{ id: 'fresh-project' }] },
    '/api/v1/datasets': { datasets: [] },
    '/api/v1/tasks': { tasks: [{ id: 'fresh-task' }] },
    '/api/v1/processing/providers?limit=100': { providers: [{ id: 'fresh-node' }] },
    '/api/v1/processing/outputs': { outputs: [] },
  };
  const reply = path => failing.has(path)
    ? Promise.reject(new Error(`${path} returned 503`))
    : Promise.resolve(fixtures[path] || {});
  const renders = [];
  const element = () => ({ className: '', textContent: '' });
  const context = vm.createContext({
    state: { token: 'token', projects: [], datasets: [], tasks: [], providers: [], presets: [], outputs: [], failedMutations: [], operations: [], derivativeJobs: [], storage: null, ...previous },
    pagedApi: path => reply(path),
    api: path => reply(path),
    pagedStorage: () => Promise.resolve({ usage: {}, items: [] }),
    can: () => false,
    access() { throw new Error('access() should not run with a token'); },
    validateWorkspaceView() {},
    syncWorkspaceView() {},
    render: () => renders.push(true),
    hydrateExpandedTask() {},
    scheduleOperationRefresh() {},
    document: { querySelector: element },
    encodeURIComponent,
    Promise,
    Object,
  });
  vm.runInContext(`${line('async function load(')};globalThis.load=load;`, context);
  return { context, renders };
}

test('a failed core request keeps the last loaded data and reports which source failed', async () => {
  const previous = { projects: [{ id: 'kept-project' }], providers: [{ id: 'kept-node' }], loaded: true };
  const { context, renders } = harness({ failing: new Set(['/api/v1/projects', '/api/v1/processing/providers?limit=100']), previous });
  await context.load();
  assert.deepEqual(plain(context.state.projects.map(project => project.id)), ['kept-project']);
  assert.deepEqual(plain(context.state.providers.map(provider => provider.id)), ['kept-node']);
  assert.deepEqual(plain(context.state.tasks.map(task => task.id)), ['fresh-task']);
  assert.deepEqual(plain(context.state.loadErrors.map(error => error.label)), ['projects', 'processing nodes']);
  assert.match(context.state.loadErrors[0].message, /503/);
  assert.equal(renders.length, 1);
});

test('a clean load clears earlier load errors', async () => {
  const { context } = harness({ previous: { loadErrors: [{ label: 'projects', message: 'old' }] } });
  await context.load();
  assert.deepEqual(plain(context.state.loadErrors), []);
  assert.deepEqual(plain(context.state.projects.map(project => project.id)), ['fresh-project']);
  assert.equal(context.state.loaded, true);
});

test('render shows a retryable alert instead of an empty list when data failed to load', () => {
  const render = line('function render(');
  assert.match(render, /load-error-banner" role="alert"/);
  assert.match(render, /data-load-retry>Try again</);
  assert.match(line('function bind('), /\[data-load-retry\][\s\S]*refreshWorkspace\(\)/);
});

test('navigation marks the current section and modals return focus to their opener', () => {
  assert.match(line('function renderNav('), /aria-current="page"/);
  assert.match(line('function openModal('), /addEventListener\('close'[\s\S]*opener\.focus\(\)/);
});
