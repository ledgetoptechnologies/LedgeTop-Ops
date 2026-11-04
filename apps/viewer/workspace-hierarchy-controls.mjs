// Customer and group management for the workspace. Display metadata only: none of these
// controls change model access, Operations membership or shares (see docs/workspace-hierarchy-api.md).

const byName = (a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'en-US', { sensitivity: 'base' });

const ERROR_MESSAGES = {
  hierarchy_revision_conflict: 'This changed somewhere else. The list has been refreshed; please try again.',
  organization_archived: 'That customer is archived. Restore it before adding projects or groups to it.',
  group_archived: 'That group is archived. Restore it before adding projects to it.',
  group_organization_mismatch: 'That group belongs to a different customer.',
  organization_not_found: 'That customer no longer exists. The list has been refreshed.',
  group_not_found: 'That group no longer exists. The list has been refreshed.',
  invalid_display_name: 'Names must be 1 to 200 characters, with no control characters.',
  hierarchy_schema_conflict: 'Customer grouping is unavailable on this server. Nothing was changed.',
};

/** Plain-language message for a failed hierarchy request. */
export function hierarchyErrorMessage(error) {
  return ERROR_MESSAGES[error?.code] || ERROR_MESSAGES[error?.message] || error?.message || 'The change could not be saved.';
}

/** True when the change should be followed by a refresh, because the data on screen is stale. */
export function hierarchyNeedsRefresh(error) {
  return error?.status === 409 || error?.status === 404;
}

/** Staff may manage customers only when the server says so and they hold project write permission. */
export function canManageHierarchy(hierarchy, can) {
  return Boolean(hierarchy?.capabilities?.manageHierarchy) && can('viewer.projects.write');
}

/** Active customers, sorted by name: the only ones a project can be assigned to. */
export function assignableOrganizations(hierarchy) {
  return (hierarchy?.organizations || []).filter(organization => organization.status === 'active').sort(byName);
}

/** Active groups of one customer, sorted by name. */
export function assignableGroups(hierarchy, organizationId) {
  return (hierarchy?.groups || []).filter(group => group.organizationId === organizationId && group.status === 'active').sort(byName);
}

/** Request body for PATCH /api/v1/projects/:id/hierarchy. Empty choices clear the assignment. */
export function assignmentBody(project, organizationId, groupId) {
  const organization = organizationId || null;
  return { organizationId: organization, groupId: organization && groupId ? groupId : null, expectedRevision: Number(project?.hierarchyRevision) || 0 };
}

/** HTML for the Customers dialog. Buttons carry data-hierarchy (operation), data-kind and data-id. */
export function customersPanel(hierarchy, esc, projects = []) {
  const organizations = [...(hierarchy?.organizations || [])].sort((a, b) => (a.status === b.status ? byName(a, b) : a.status === 'active' ? -1 : 1));
  const counts = new Map();
  for (const project of projects) if (project.organizationId) counts.set(project.organizationId, (counts.get(project.organizationId) || 0) + 1);
  const action = (operation, kind, id, label, danger = false) => `<button type="button" class="secondary-button${danger ? ' danger-button' : ''}" data-hierarchy="${operation}" data-kind="${kind}" data-id="${esc(id)}">${esc(label)}</button>`;
  const lifecycle = (kind, entity) => entity.status === 'active' ? action('archive', kind, entity.id, 'Archive', true) : action('restore', kind, entity.id, 'Restore');
  const rows = organizations.map(organization => {
    const groups = (hierarchy.groups || []).filter(group => group.organizationId === organization.id).sort(byName);
    const archived = organization.status !== 'active';
    const count = counts.get(organization.id) || 0;
    return `<article class="customer-row${archived ? ' archived' : ''}" data-customer-id="${esc(organization.id)}"><div class="customer-heading"><div><strong>${esc(organization.displayName)}</strong><small>${count} ${count === 1 ? 'project' : 'projects'}${archived ? ' · archived' : ''}</small></div><div class="row-actions">${action('rename', 'organization', organization.id, 'Rename')}${archived ? '' : action('add-group', 'organization', organization.id, 'Add group')}${lifecycle('organization', organization)}</div></div>${groups.length ? `<ul class="customer-groups">${groups.map(group => `<li class="${group.status !== 'active' ? 'archived' : ''}" data-group-id="${esc(group.id)}"><span>${esc(group.displayName)}${group.status !== 'active' ? ' <small>archived</small>' : ''}</span><span class="row-actions">${action('rename', 'group', group.id, 'Rename')}${archived ? '' : lifecycle('group', group)}</span></li>`).join('')}</ul>` : ''}</article>`;
  }).join('');
  return `<p class="form-note">Customers and groups only organize the project list. They don't change who can see a model.</p><div class="row-actions customers-toolbar"><button type="button" class="primary-button" data-hierarchy="add-organization" data-kind="organization" data-id="">Add customer</button></div><div class="customer-list">${rows || '<div class="empty-state">No customers yet. Add one, then set it on a project from the project\'s ⋯ menu.</div>'}</div>`;
}
