'use strict';

const { canonicalProjectSelection } = require('./projectSelection');

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const source = value => typeof value === 'string' && /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const date = value => value === null || typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const cursor = value => value === null || id(value);
// Name-ordered client picker cursor from Operations: "v1." + base64url.
const clientCursor = value => cursor(value) || typeof value === 'string' && value.length <= 1500 && /^v1\.[A-Za-z0-9_-]+$/.test(value);
const directClient = client => exact(client, ['sourceId', 'workspaceId', 'displayName', 'businessName', 'organizationName', 'rootType'])
  && source(client.sourceId) && id(client.workspaceId) && text(client.displayName) && text(client.businessName)
  && (client.organizationName === undefined || client.organizationName === null || text(client.organizationName))
  && (client.rootType === undefined || ['organization', 'standalone_client'].includes(client.rootType));
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
// `report` (model report download) is optional: a share made before it existed, or by an Operations that cannot store it, has none.
const permissions = value => exact(value, ['measure', 'cameras', 'download', 'report']) && ['measure', 'cameras', 'download'].every(key => typeof value[key] === 'boolean')
  && (value.report === undefined || typeof value.report === 'boolean');

function grantScope(value) {
  return source(value.sourceId) && id(value.workspaceId) && id(value.viewerProjectId)
    && ['project', 'task'].includes(value.scopeType) && permissions(value.permissions) && date(value.expiresAt)
    && (value.scopeType === 'project' ? value.taskId === null && value.includeFuturePublished === true
      : id(value.taskId) && value.includeFuturePublished === false);
}
const selected = value => value.selection === undefined || value.scopeType === 'project' && canonicalProjectSelection(value.selection) !== null;
// The shares a new one takes the place of: exact ids and versions, unique.
const validReplaces = value => Array.isArray(value) && value.length <= 100
  && value.every(item => exact(item, ['grantId', 'grantVersion']) && id(item.grantId) && Number.isSafeInteger(item.grantVersion) && item.grantVersion > 0)
  && new Set(value.map(item => item.grantId)).size === value.length;
const validRevocation = value => exact(value, ['pending', 'revokedGrants', 'revokedSessions']) && typeof value.pending === 'boolean'
  && ['revokedGrants', 'revokedSessions'].every(key => value[key] === undefined || Number.isSafeInteger(value[key]) && value[key] >= 0);
function validDirectGrantInput(value) {
  return exact(value, ['sourceId', 'workspaceId', 'viewerProjectId', 'taskId', 'scopeType', 'includeFuturePublished', 'permissions', 'expiresAt', 'confirmedScope', 'selection', 'replaces'])
    && grantScope(value) && value.confirmedScope === true
    && selected(value) && (value.replaces === undefined || value.scopeType === 'project' && validReplaces(value.replaces));
}
function validDirectGrant(value) {
  return exact(value, ['grantId', 'sourceId', 'workspaceId', 'viewerProjectId', 'taskId', 'scopeType', 'includeFuturePublished', 'permissions', 'expiresAt',
    'grantVersion', 'revokedAt', 'clientDisplayName', 'createdAt', 'createdBy', 'selection'])
    && id(value.grantId) && grantScope(value) && Number.isSafeInteger(value.grantVersion) && value.grantVersion > 0
    && date(value.revokedAt) && (value.clientDisplayName === null || text(value.clientDisplayName)) && value.createdAt !== null && date(value.createdAt)
    && (value.createdBy === undefined || text(value.createdBy)) && selected(value);
}
function validDirectSnapshot(value, action) {
  if (action === 'create') return exact(value, ['grant', 'replayed', 'sessionRevocation']) && validDirectGrant(value.grant) && typeof value.replayed === 'boolean'
    && (value.sessionRevocation === undefined || validRevocation(value.sessionRevocation));
  if (action === 'revoke') return exact(value, ['success', 'replayed', 'sessionRevocation']) && value.success === true && typeof value.replayed === 'boolean'
    && validRevocation(value.sessionRevocation);
  return exact(value, ['clients', 'grants', 'clientsNextCursor', 'grantsNextCursor', 'capabilities', 'modelReport'])
    && (value.modelReport === undefined || typeof value.modelReport === 'boolean')
    && (value.capabilities === undefined || exact(value.capabilities, ['replaces', 'notifyClient']) && typeof value.capabilities.replaces === 'boolean'
      && (value.capabilities.notifyClient === undefined || value.capabilities.notifyClient === true))
    && Array.isArray(value.clients) && value.clients.length <= 50 && value.clients.every(directClient)
    && Array.isArray(value.grants) && value.grants.length <= 500 && value.grants.every(validDirectGrant)
    && clientCursor(value.clientsNextCursor) && (value.grantsNextCursor === undefined || cursor(value.grantsNextCursor));
}
function directListQuery(query) {
  if (!exact(query, ['q', 'cursor', 'limit', 'viewerProjectId', 'include', 'grantsCursor'])) return null;
  if (query.include !== undefined && !['all', 'clients', 'grants'].includes(query.include)) return null;
  if (query.grantsCursor !== undefined && !id(query.grantsCursor)) return null;
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 120 || /[\u0000-\u001f\u007f]/.test(query.q))) return null;
  if (query.cursor !== undefined && (query.cursor === null || !clientCursor(query.cursor))) return null;
  if (query.viewerProjectId !== undefined && !id(query.viewerProjectId)) return null;
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d{1,2}$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 50)) return null;
  return { ...(query.q !== undefined ? { q: query.q } : {}), ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}), ...(query.viewerProjectId !== undefined ? { viewerProjectId: query.viewerProjectId } : {}),
    ...(query.include !== undefined ? { include: query.include } : {}), ...(query.grantsCursor !== undefined ? { grantsCursor: query.grantsCursor } : {}) };
}

// Optional grouping of one real client's workspaces across divisions (shared-profile link only).
// Each group is 2-4 [sourceId, workspaceId] pairs in distinct sources; no workspace is in two groups.
const DIRECT_GROUP_LIMIT = 250;
function validDirectGroups(value) {
  if (!exact(value, ['groups']) || !Array.isArray(value.groups) || value.groups.length > DIRECT_GROUP_LIMIT) return false;
  const seen = new Set();
  return value.groups.every(group => Array.isArray(group) && group.length >= 2 && group.length <= 4
    && new Set(group.map(pair => Array.isArray(pair) ? pair[0] : null)).size === group.length
    && group.every(pair => Array.isArray(pair) && pair.length === 2 && source(pair[0]) && id(pair[1])
      && !seen.has(pair[1]) && seen.add(pair[1])));
}

module.exports = { validReplaces, validDirectGrantInput, validDirectSnapshot, directListQuery, validDirectGroups, DIRECT_GROUP_LIMIT };
