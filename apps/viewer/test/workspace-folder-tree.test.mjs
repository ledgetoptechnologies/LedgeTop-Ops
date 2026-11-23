import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OPEN_PROJECTS, folderAncestry, folderIsEmpty, folderTaskCounts, limitOpenProjects, projectTreeRows, readTreeState, treeKeyAction, treeStorageKey, writeTreeState } from '../workspace-folder-tree.mjs';

const folders = [
  { id: 'b', projectId: 'p', parentId: null, displayName: 'Folder 10' },
  { id: 'a', projectId: 'p', parentId: null, displayName: 'Folder 9' },
  { id: 'a1', projectId: 'p', parentId: 'a', displayName: 'Spring' },
  { id: 'loop1', projectId: 'p', parentId: 'loop2', displayName: 'Loop one' },
  { id: 'loop2', projectId: 'p', parentId: 'loop1', displayName: 'Loop two' },
];
const tasks = [
  { id: 't-root', folderId: null }, { id: 't-a', folderId: 'a' }, { id: 't-a1', folderId: 'a1' }, { id: 't-lost', folderId: 'deleted-elsewhere' },
];

test('expanded projects and folders are saved per user and survive bad or blocked storage', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(writeTreeState(storage, 'ops:alice', { projects: new Set(['p']), folders: new Set(['a', 'a1']) }), true);
  assert.deepEqual(readTreeState(storage, 'ops:alice'), { projects: new Set(['p']), folders: new Set(['a', 'a1']) });
  assert.deepEqual(readTreeState(storage, 'ops:bob'), { projects: new Set(), folders: new Set() }, 'another user starts closed');
  assert.ok(values.has(treeStorageKey('ops:alice')) && !values.has(treeStorageKey('ops:bob')));
  values.set(treeStorageKey('ops:alice'), '{not json');
  assert.deepEqual(readTreeState(storage, 'ops:alice'), { projects: new Set(), folders: new Set() });
  values.set(treeStorageKey('ops:alice'), JSON.stringify({ projects: ['p', 7, '', 'x'.repeat(201)], folders: 'a' }));
  assert.deepEqual(readTreeState(storage, 'ops:alice'), { projects: new Set(['p']), folders: new Set() }, 'only short string ids are kept');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(readTreeState(blocked, 'ops:alice'), { projects: new Set(), folders: new Set() });
  assert.equal(writeTreeState(blocked, 'ops:alice', { projects: new Set(), folders: new Set() }), false);
  assert.equal(writeTreeState(undefined, 'ops:alice', { projects: new Set(), folders: new Set() }), true, 'no storage is not an error');
});

test('project rows list folders by name (numbers in order), then tasks, children under open folders', () => {
  let rows = projectTreeRows({ projectId: 'p', folders, tasks, expanded: new Set() });
  assert.deepEqual(rows.map(row => row.key), ['f:a', 'f:b', 't:t-root', 't:t-lost']);
  assert.deepEqual(rows.map(row => [row.level, row.posinset, row.setsize]), [[2, 1, 4], [2, 2, 4], [2, 3, 4], [2, 4, 4]]);
  assert.equal(rows[0].parentKey, 'p:p');
  rows = projectTreeRows({ projectId: 'p', folders, tasks, expanded: new Set(['a', 'a1', 'b']) });
  assert.deepEqual(rows.map(row => `${row.key}@${row.level}`), ['f:a@2', 'f:a1@3', 't:t-a1@4', 't:t-a@3', 'f:b@2', 'e:b@3', 't:t-root@2', 't:t-lost@2']);
  assert.equal(rows.find(row => row.key === 't:t-a1').parentKey, 'f:a1');
  assert.equal(rows.find(row => row.key === 'e:b').folderId, 'b', 'an empty open folder gets a drop row');
  // Folders in a parent cycle are never reachable from the top, so they cannot loop the tree.
  assert.equal(rows.some(row => row.key.startsWith('f:loop')), false);
});

test('an inline new-folder row sits first in its parent and replaces the empty row', () => {
  let rows = projectTreeRows({ projectId: 'p', folders, tasks, expanded: new Set(['b']), pending: { parentId: 'b' } });
  assert.deepEqual(rows.map(row => row.key), ['f:a', 'f:b', 'n:b', 't:t-root', 't:t-lost']);
  assert.equal(rows[2].level, 3);
  rows = projectTreeRows({ projectId: 'p', folders, tasks, expanded: new Set(), pending: { parentId: null } });
  assert.deepEqual(rows.map(row => row.key)[0], 'n:p');
});

test('folder counts include subfolders; only folders with no tasks and no subfolders are empty', () => {
  const counts = folderTaskCounts(folders, tasks);
  assert.equal(counts.get('a'), 2); assert.equal(counts.get('a1'), 1); assert.equal(counts.get('b'), 0);
  assert.equal(folderIsEmpty(folders, tasks, 'b'), true);
  assert.equal(folderIsEmpty(folders, [], 'a'), false, 'a subfolder keeps its parent from being deleted');
  assert.deepEqual(folderAncestry(folders, 'a1'), ['a', 'a1']);
  assert.deepEqual(folderAncestry(folders, 'missing'), []);
  assert.deepEqual(folderAncestry(folders, 'loop1').sort(), ['loop1', 'loop2']);
});

test('arrow keys move through visible rows, open and close folders, and step to the parent', () => {
  const rows = [
    { level: 1, expandable: true, expanded: true }, // project
    { level: 2, expandable: true, expanded: true }, // folder
    { level: 3, expandable: false }, // task in folder
    { level: 2, expandable: true, expanded: false }, // closed folder
    { level: 2, expandable: false }, // top-level task
  ];
  assert.deepEqual(treeKeyAction(rows, 0, 'ArrowDown'), { focus: 1 });
  assert.equal(treeKeyAction(rows, 4, 'ArrowDown'), null);
  assert.deepEqual(treeKeyAction(rows, 2, 'ArrowUp'), { focus: 1 });
  assert.deepEqual(treeKeyAction(rows, 3, 'Home'), { focus: 0 });
  assert.deepEqual(treeKeyAction(rows, 0, 'End'), { focus: 4 });
  assert.deepEqual(treeKeyAction(rows, 3, 'ArrowRight'), { toggle: true }, 'Right opens a closed folder');
  assert.deepEqual(treeKeyAction(rows, 1, 'ArrowRight'), { focus: 2 }, 'Right on an open folder enters its first child');
  assert.deepEqual(treeKeyAction(rows, 2, 'ArrowRight'), { controls: true }, 'Right on a task steps into its buttons');
  assert.deepEqual(treeKeyAction(rows, 1, 'ArrowLeft'), { toggle: true }, 'Left closes an open folder');
  assert.deepEqual(treeKeyAction(rows, 2, 'ArrowLeft'), { focus: 1 }, 'Left on a child goes to its parent');
  assert.deepEqual(treeKeyAction(rows, 4, 'ArrowLeft'), { focus: 0 });
  assert.equal(treeKeyAction(rows, 2, 'x'), null);
});

test('at most ten projects stay open: the most recently opened, never the selected one', () => {
  assert.equal(MAX_OPEN_PROJECTS, 10);
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const many = Array.from({ length: 14 }, (_, index) => `p${index}`);
  values.set(treeStorageKey('ops:alice'), JSON.stringify({ projects: many, folders: [] }));
  assert.deepEqual([...readTreeState(storage, 'ops:alice').projects], many.slice(-10), 'a saved list is cut to the last ten');
  writeTreeState(storage, 'ops:alice', { projects: new Set(many), folders: new Set() });
  assert.deepEqual(JSON.parse(values.get(treeStorageKey('ops:alice'))).projects, many.slice(-10));
  const open = limitOpenProjects(new Set(many), 'p0');
  assert.equal(open.size, 10); assert.ok(open.has('p0'), 'the selected project stays open'); assert.ok(open.has('p13'));
  assert.equal(open.has('p1'), false);
});
