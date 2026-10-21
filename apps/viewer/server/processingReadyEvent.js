'use strict';

function processingReadyEvent(processing, config, attempt) {
  const task = processing.getTask(attempt.taskId);
  const project = task && processing.getProject(task.projectId);
  if (!task || !project) throw Object.assign(new Error('processing readiness context is unavailable'), { code: 'readiness_context_unavailable' });
  return {
    eventId: `processing-ready-${attempt.id}`,
    schemaVersion: 1,
    type: 'processing.ready_for_review',
    projectId: project.id,
    projectDisplayName: project.displayName,
    taskId: task.id,
    taskDisplayName: task.displayName,
    attemptId: attempt.id,
    requestedBySubject: attempt.createdBy,
    status: 'ready_for_review',
    reviewUrl: `${config.opsBaseUrl}/operations/processing?attemptId=${encodeURIComponent(attempt.id)}`,
  };
}

module.exports = { processingReadyEvent };
