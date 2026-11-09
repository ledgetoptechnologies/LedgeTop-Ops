import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assignableGroups, assignableOrganizations, assignmentBody, canManageHierarchy, customersPanel, hierarchyErrorMessage, hierarchyNeedsRefresh } from '../workspace-hierarchy-controls.mjs';

const esc = value => String(value).replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const hierarchy = {
  capabilities: { manageHierarchy: true },
  organizations: [
    { id: 'org-zeta', displayName: 'Zeta Farms', status: 'active', revision: 2 },
    { id: 'org-old', displayName: 'Old Customer', status: 'archived', revision: 4 },
    { id: 'org-alpha', displayName: 'Alpha <County>', status: 'active', revision: 1 },
  ],
  groups: [
    { id: 'group-roads', organizationId: 'org-alpha', displayName: 'Roads', status: 'active', revision: 1 },
    { id: 'group-closed', organizationId: 'org-alpha', displayName: 'Closed sites', status: 'archived', revision: 3 },
    { id: 'group-other', organizationId: 'org-zeta', displayName: 'Barns', status: 'active', revision: 1 },
  ],
};

test('controls appear only when the server grants management and the staff member can write projects', () => {
  assert.equal(canManageHierarchy(hierarchy, () => true), true);
  assert.equal(canManageHierarchy(hierarchy, permission => permission !== 'viewer.projects.write'), false);
  assert.equal(canManageHierarchy({ ...hierarchy, capabilities: { manageHierarchy: false } }, () => true), false);
  assert.equal(canManageHierarchy(null, () => true), false, 'no endpoint (404) means no controls');
});

test('only active customers and that customer\'s active groups can be chosen', () => {
  assert.deepEqual(assignableOrganizations(hierarchy).map(item => item.id), ['org-alpha', 'org-zeta']);
  assert.deepEqual(assignableGroups(hierarchy, 'org-alpha').map(item => item.id), ['group-roads']);
  assert.deepEqual(assignableGroups(hierarchy, 'org-old'), []);
});

test('assignment bodies use exact ids, the project revision, and null to clear', () => {
  assert.deepEqual(assignmentBody({ hierarchyRevision: 3 }, 'org-alpha', 'group-roads'), { organizationId: 'org-alpha', groupId: 'group-roads', expectedRevision: 3 });
  assert.deepEqual(assignmentBody({ hierarchyRevision: 3 }, '', ''), { organizationId: null, groupId: null, expectedRevision: 3 });
  assert.deepEqual(assignmentBody({}, 'org-alpha', ''), { organizationId: 'org-alpha', groupId: null, expectedRevision: 0 }, 'legacy projects start at revision 0');
  assert.deepEqual(assignmentBody({ hierarchyRevision: 1 }, '', 'group-roads'), { organizationId: null, groupId: null, expectedRevision: 1 }, 'a group never survives clearing the customer');
});

test('conflicts and missing records refresh the data and explain why', () => {
  const conflict = Object.assign(new Error('hierarchy_revision_conflict'), { status: 409, code: 'hierarchy_revision_conflict' });
  assert.match(hierarchyErrorMessage(conflict), /changed somewhere else/);
  assert.equal(hierarchyNeedsRefresh(conflict), true);
  assert.equal(hierarchyNeedsRefresh(Object.assign(new Error('gone'), { status: 404 })), true);
  assert.equal(hierarchyNeedsRefresh(Object.assign(new Error('bad'), { status: 400 })), false);
  assert.match(hierarchyErrorMessage({ code: 'group_organization_mismatch' }), /different customer/);
  assert.equal(hierarchyErrorMessage({ message: 'Something else' }), 'Something else');
});

test('the Customers dialog lists active customers first, escapes names and offers archive or restore', () => {
  const html = customersPanel(hierarchy, esc, [{ organizationId: 'org-alpha' }, { organizationId: 'org-alpha' }, { organizationId: null }]);
  const order = [...html.matchAll(/data-customer-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(order, ['org-alpha', 'org-zeta', 'org-old']);
  assert.match(html, /Alpha &#60;County&#62;/);
  assert.doesNotMatch(html, /Alpha <County>/);
  assert.match(html, /<small>2 projects<\/small>/);
  assert.match(html, /data-hierarchy="archive" data-kind="group" data-id="group-roads"/);
  assert.match(html, /data-hierarchy="create-project" data-kind="organization" data-id="org-alpha">Create project<\/button>/);
  assert.match(html, /data-hierarchy="restore" data-kind="group" data-id="group-closed"/);
  assert.match(html, /data-hierarchy="restore" data-kind="organization" data-id="org-old"/);
  assert.doesNotMatch(html, /data-hierarchy="add-group" data-kind="organization" data-id="org-old"/, 'no new groups inside an archived customer');
  assert.doesNotMatch(html, /data-hierarchy="create-project" data-kind="organization" data-id="org-old"/, 'no project creation inside an archived customer');
  assert.doesNotMatch(html, /delete/i, 'there is no delete');
  assert.match(html, /don't change who can see a model/);
});

test('the workspace wires the controls only behind the management capability', async () => {
  const source = await readFile(new URL('../workspace-projects.js', import.meta.url), 'utf8');
  assert.match(source, /\$\{canManageHierarchy\(state\.hierarchy,can\)\?'<button type="button" class="secondary-button" data-action="manage-customers"/);
  assert.match(source, /\$\{canManageHierarchy\(state\.hierarchy,can\)\?button\('set-project-customer',project\.id,'Set customer'\):''\}/);
  assert.match(source, /hierarchyWrite\(`\/api\/v1\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/hierarchy`,'PATCH',assignmentBody\(/);
  assert.match(source, /\/api\/v1\/processing\/organizations\/\$\{encodeURIComponent\(entity\.id\)\}\/projects`,'POST',body,'Project created for customer'/);
  assert.match(source, /JSON\.stringify\(\[entity\.id,body\]\).*key=`viewer\.customer-project\.v1:\$\{digest\}`/, 'the same request key is reproducible after losing tab session storage');
});
