'use strict';

const { canonicalProjectExclusions } = require('./projectExclusions');
const { activePublishedProjectTaskRow } = require('./processingRepository');

function restrictedSessionScope(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'exclusions,projectId,taskId,version'
    || value.version !== 1 || ![value.projectId, value.taskId].every(id =>
      typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) return null;
  const exclusions = canonicalProjectExclusions(value.exclusions);
  return exclusions ? { version: 1, projectId: value.projectId, taskId: value.taskId, exclusions } : null;
}

function restrictedSessionAllows(database, session) {
  if (session.restrictedScope === undefined) return true;
  const scope = restrictedSessionScope(session.restrictedScope);
  if (!scope || session.audience !== 'client' || session.sessionMode !== 'published'
    || session.sourceAuthorization?.type !== 'direct_client_grant'
    || !session.sourceAuthorization.id || !Number.isSafeInteger(session.sourceAuthorization.version)
    || session.sourceAuthorization.version < 1) return false;
  const published = activePublishedProjectTaskRow(database, scope.projectId, scope.taskId, { exclusions: scope.exclusions });
  return Boolean(published && published.model_id === session.modelId && published.model_version_id === session.modelVersionId);
}

module.exports = { restrictedSessionScope, restrictedSessionAllows };
