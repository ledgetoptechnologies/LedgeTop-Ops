'use strict';

const { canonicalProjectExclusions } = require('./projectExclusions');
const { activePublishedProjectTaskRow } = require('./processingRepository');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The generation is the exact task authorization generation the issuer captured
// from the catalog. It is compared with the current value at mint, redemption
// and every live session check, so a credential never survives a scope change
// even when the task later returns to an eligible place.
function restrictedSessionScope(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'exclusions,generation,projectId,taskId,version'
    || value.version !== 1 || ![value.projectId, value.taskId].every(id => typeof id === 'string' && UUID.test(id))
    || !Number.isSafeInteger(value.generation) || value.generation < 1) return null;
  const exclusions = canonicalProjectExclusions(value.exclusions);
  return exclusions
    ? { version: 1, projectId: value.projectId, taskId: value.taskId, generation: value.generation, exclusions }
    : null;
}

/** Current generation, or null when the table or the task's row is missing (deny). */
function currentTaskAuthorizationGeneration(database, taskId) {
  try {
    const row = database.prepare('SELECT generation FROM task_authorization_generations WHERE task_id=?').get(taskId);
    return row && Number.isSafeInteger(row.generation) && row.generation >= 1 ? row.generation : null;
  } catch {
    return null;
  }
}

function restrictedSessionAllows(database, session) {
  if (session.restrictedScope === undefined) return true;
  const scope = restrictedSessionScope(session.restrictedScope);
  if (!scope || session.audience !== 'client' || session.sessionMode !== 'published'
    || session.sourceAuthorization?.type !== 'direct_client_grant'
    || !session.sourceAuthorization.id || !Number.isSafeInteger(session.sourceAuthorization.version)
    || session.sourceAuthorization.version < 1) return false;
  if (currentTaskAuthorizationGeneration(database, scope.taskId) !== scope.generation) return false;
  const published = activePublishedProjectTaskRow(database, scope.projectId, scope.taskId, { exclusions: scope.exclusions });
  return Boolean(published && published.model_id === session.modelId && published.model_version_id === session.modelVersionId);
}

module.exports = { restrictedSessionScope, restrictedSessionAllows, currentTaskAuthorizationGeneration };
