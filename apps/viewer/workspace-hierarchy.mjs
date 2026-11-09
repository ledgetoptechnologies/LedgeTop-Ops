// Display-only customer grouping for the workspace project list.
// Grouping never grants access and never matches clients by name: a project joins a
// customer only through its exact organizationId. Group remains staff metadata.

const byName = (a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'en-US', { sensitivity: 'base' });

/** Collect every page of GET /api/v1/processing/hierarchy before grouping (rows of one kind may span pages). */
export async function loadHierarchy(fetchPage, { maxPages = 100 } = {}) {
  const organizations = [], groups = [];
  let cursor = null, capabilities = {};
  for (let page = 0; page < maxPages; page += 1) {
    const body = await fetchPage(cursor);
    if (body?.schemaVersion !== 1) throw new Error('Unsupported hierarchy schema');
    organizations.push(...(body.organizations || []));
    groups.push(...(body.groups || []));
    capabilities = body.capabilities || capabilities;
    cursor = body.nextCursor || null;
    if (!cursor) return { organizations, groups, capabilities };
  }
  throw new Error('Hierarchy listing did not finish');
}

/**
 * Split projects into customer sections. Returns null when no project belongs to a known
 * organization, so the caller keeps today's flat list. Unassigned is always last.
 */
export function groupProjects(projects, hierarchy) {
  const organizations = new Map((hierarchy?.organizations || []).map(organization => [organization.id, organization]));
  const sections = new Map();
  const unassigned = [];
  for (const project of projects) {
    const organization = project.organizationId ? organizations.get(project.organizationId) : null;
    if (!organization) { unassigned.push(project); continue; }
    if (!sections.has(organization.id)) sections.set(organization.id, { organization, projects: [] });
    sections.get(organization.id).projects.push(project);
  }
  if (!sections.size) return null;
  const ordered = [...sections.values()].sort((a, b) => byName(a.organization, b.organization)).map(section => ({
    id: section.organization.id,
    label: section.organization.displayName || 'Unnamed customer',
    archived: section.organization.status === 'archived',
    projects: section.projects,
    count: section.projects.length,
  }));
  if (unassigned.length) ordered.push({ id: null, label: 'Unassigned', archived: false, projects: unassigned, count: unassigned.length });
  return ordered;
}
