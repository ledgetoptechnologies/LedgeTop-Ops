import assert from 'node:assert/strict';
import test from 'node:test';
import { groupProjects, loadHierarchy } from '../workspace-hierarchy.mjs';

// Shapes follow Codex's workspace-hierarchy.contract.json (schemaVersion 1, sha256 5b328859…).
const hierarchy = {
  organizations: [
    { id: 'org-b', displayName: 'Brookside Farms', status: 'active', revision: 1 },
    { id: 'org-a', displayName: 'Alder County', status: 'archived', revision: 2 },
  ],
  groups: [
    { id: 'group-roads', organizationId: 'org-a', displayName: 'Roads', status: 'active', revision: 1 },
    { id: 'group-foreign', organizationId: 'org-b', displayName: 'Other customer group', status: 'active', revision: 1 },
  ],
};
const project = (id, organizationId = null, groupId = null) => ({ id, displayName: id, organizationId, groupId, hierarchyRevision: organizationId ? 1 : 0 });

test('legacy projects with no organization keep the flat list', () => {
  assert.equal(groupProjects([project('a'), project('b')], hierarchy), null);
  assert.equal(groupProjects([project('a', 'org-a')], null), null);
});

test('projects group only by exact customer id; group assignments do not create a navigation tier', () => {
  const sections = groupProjects([project('legacy'), project('farm', 'org-b'), project('road', 'org-a', 'group-roads'), project('county', 'org-a')], hierarchy);
  assert.deepEqual(sections.map(section => section.label), ['Alder County', 'Brookside Farms', 'Unassigned']);
  const county = sections[0];
  assert.equal(county.archived, true);
  assert.equal(county.count, 2);
  assert.deepEqual(county.projects.map(item => item.id), ['road', 'county']);
  assert.equal(sections.at(-1).id, null);
  assert.deepEqual(sections.at(-1).projects.map(item => item.id), ['legacy']);
});

test('hierarchy loading accepts more than twenty pages with the explicit page size', async () => {
  let calls = 0;
  const loaded = await loadHierarchy(async cursor => {
    calls += 1;
    const page = Number(cursor || 0);
    return { schemaVersion: 1, organizations: [{ id: `org-${page}`, displayName: `Org ${page}` }], groups: [], nextCursor: page < 20 ? String(page + 1) : null };
  });
  assert.equal(calls, 21);
  assert.equal(loaded.organizations.length, 21);
});

test('unknown ids and groups from another customer never move or merge projects', () => {
  const sections = groupProjects([project('ghost', 'org-missing'), project('mismatch', 'org-a', 'group-foreign'), project('same-name', 'org-b')], {
    ...hierarchy,
    organizations: [...hierarchy.organizations, { id: 'org-c', displayName: 'Brookside Farms', status: 'active', revision: 1 }],
  });
  assert.deepEqual(sections.map(section => [section.id, section.projects.map(item => item.id)]), [
    ['org-a', ['mismatch']],
    ['org-b', ['same-name']],
    [null, ['ghost']],
  ]);
});

test('hierarchy pages are collected before grouping and bad schemas are rejected', async () => {
  const pages = {
    null: { schemaVersion: 1, organizations: [hierarchy.organizations[0]], groups: [hierarchy.groups[1]], nextCursor: 'page-2', capabilities: { manageHierarchy: false } },
    'page-2': { schemaVersion: 1, organizations: [hierarchy.organizations[1]], groups: [hierarchy.groups[0]], nextCursor: null, capabilities: { manageHierarchy: false } },
  };
  const seen = [];
  const loaded = await loadHierarchy(cursor => { seen.push(cursor); return Promise.resolve(pages[cursor]); });
  assert.deepEqual(seen, [null, 'page-2']);
  assert.deepEqual(loaded.organizations.map(item => item.id), ['org-b', 'org-a']);
  assert.deepEqual(loaded.groups.map(item => item.id), ['group-foreign', 'group-roads']);
  assert.equal(loaded.capabilities.manageHierarchy, false);
  await assert.rejects(loadHierarchy(() => Promise.resolve({ schemaVersion: 2 })), /Unsupported hierarchy schema/);
  await assert.rejects(loadHierarchy(() => Promise.resolve({ schemaVersion: 1, nextCursor: 'again' }), { maxPages: 3 }), /did not finish/);
});
