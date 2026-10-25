'use strict';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const source = value => typeof value === 'string' && /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const date = value => value === null || typeof value === 'string' && value.length <= 40 && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const cursor = value => value === null || id(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const permissions = value => exact(value, ['measure', 'cameras', 'download']) && ['measure', 'cameras', 'download'].every(key => typeof value[key] === 'boolean');

function grantScope(value) {
  return source(value.sourceId) && id(value.workspaceId) && id(value.viewerProjectId)
    && ['project', 'task'].includes(value.scopeType) && permissions(value.permissions) && date(value.expiresAt)
    && (value.scopeType === 'project' ? value.taskId === null && value.includeFuturePublished === true
      : id(value.taskId) && value.includeFuturePublished === false);
}
function validDirectGrantInput(value) {
  return exact(value, ['sourceId', 'workspaceId', 'viewerProjectId', 'taskId', 'scopeType', 'includeFuturePublished', 'permissions', 'expiresAt', 'confirmedScope'])
    && grantScope(value) && value.confirmedScope === true;
}
function validDirectGrant(value) {
  return exact(value, ['grantId', 'sourceId', 'workspaceId', 'viewerProjectId', 'taskId', 'scopeType', 'includeFuturePublished', 'permissions', 'expiresAt',
    'grantVersion', 'revokedAt', 'clientDisplayName', 'createdAt', 'createdBy'])
    && id(value.grantId) && grantScope(value) && Number.isSafeInteger(value.grantVersion) && value.grantVersion > 0
    && date(value.revokedAt) && (value.clientDisplayName === null || text(value.clientDisplayName)) && value.createdAt !== null && date(value.createdAt)
    && (value.createdBy === undefined || text(value.createdBy));
}
function validDirectSnapshot(value, action) {
  if (action === 'create') return exact(value, ['grant', 'replayed']) && validDirectGrant(value.grant) && typeof value.replayed === 'boolean';
  if (action === 'revoke') return exact(value, ['success', 'replayed', 'sessionRevocation']) && value.success === true && typeof value.replayed === 'boolean'
    && exact(value.sessionRevocation, ['pending', 'revokedGrants', 'revokedSessions']) && typeof value.sessionRevocation.pending === 'boolean'
    && ['revokedGrants', 'revokedSessions'].every(key => value.sessionRevocation[key] === undefined || Number.isSafeInteger(value.sessionRevocation[key]) && value.sessionRevocation[key] >= 0);
  return exact(value, ['clients', 'grants', 'clientsNextCursor', 'grantsNextCursor'])
    && Array.isArray(value.clients) && value.clients.length <= 50 && value.clients.every(client => exact(client, ['sourceId', 'workspaceId', 'displayName', 'businessName'])
      && source(client.sourceId) && id(client.workspaceId) && text(client.displayName) && text(client.businessName))
    && Array.isArray(value.grants) && value.grants.length <= 500 && value.grants.every(validDirectGrant)
    && cursor(value.clientsNextCursor) && (value.grantsNextCursor === undefined || cursor(value.grantsNextCursor));
}
function directListQuery(query) {
  if (!exact(query, ['q', 'cursor', 'limit', 'viewerProjectId'])) return null;
  if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 120 || /[\u0000-\u001f\u007f]/.test(query.q))) return null;
  if (query.cursor !== undefined && !cursor(query.cursor)) return null;
  if (query.viewerProjectId !== undefined && !id(query.viewerProjectId)) return null;
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^\d{1,2}$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 50)) return null;
  return { ...(query.q !== undefined ? { q: query.q } : {}), ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}), ...(query.viewerProjectId !== undefined ? { viewerProjectId: query.viewerProjectId } : {}) };
}

module.exports = { validDirectGrantInput, validDirectSnapshot, directListQuery };
