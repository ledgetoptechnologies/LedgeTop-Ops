'use strict';

const express = require('express');
const { canonicalProjectExclusions } = require('./projectExclusions');
const { currentTaskAuthorizationGeneration } = require('./restrictedSessionScope');
const { trackedRouter } = require('./httpRequestLifecycle');
const { requireService } = require('./serviceAuth');
const { ProcessingRepository } = require('./processingRepository');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createClientDeliveryCatalog(repository) {
  const router = trackedRouter();
  const processing = new ProcessingRepository(repository.database);
  router.get('/api/v1/client-delivery-catalog', requireService(repository), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { projectId, taskId, cursor, exclusionScope, validateExclusions, limit = '50' } = req.query;
    let exclusions;
    if (exclusionScope !== undefined) {
      if (typeof exclusionScope !== 'string' || !/^[A-Za-z0-9_-]{1,7200}$/.test(exclusionScope))
        return res.status(400).json({ error: 'Invalid exclusion scope', code: 'invalid_catalog_query' });
      try { exclusions = canonicalProjectExclusions(JSON.parse(Buffer.from(exclusionScope, 'base64url').toString('utf8'))); }
      catch { /* Invalid below. */ }
      if (!exclusions) return res.status(400).json({ error: 'Invalid exclusion scope', code: 'invalid_catalog_query' });
    }
    if (Object.keys(req.query).some(key => !['projectId', 'taskId', 'cursor', 'limit', 'exclusionScope', 'validateExclusions'].includes(key))
      || typeof projectId !== 'string' || !UUID.test(projectId)
      || (taskId !== undefined && (typeof taskId !== 'string' || !UUID.test(taskId)))
      || typeof limit !== 'string' || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50
      || (cursor !== undefined && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{8,2048}$/.test(cursor)))
      || (validateExclusions !== undefined && (validateExclusions !== '1' || !exclusions || taskId !== undefined || cursor !== undefined))
      || (taskId !== undefined && cursor !== undefined))
      return res.status(400).json({ error: 'Invalid client delivery catalog query', code: 'invalid_catalog_query' });
    if (cursor !== undefined) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { /* Invalid below. */ }
      if (!decoded || Object.keys(decoded).sort().join(',') !== 'createdAt,id' || !UUID.test(decoded.id)
        || typeof decoded.createdAt !== 'string' || decoded.createdAt.length > 40 || !Number.isFinite(Date.parse(decoded.createdAt)))
        return res.status(400).json({ error: 'Invalid catalog cursor', code: 'invalid_catalog_query' });
    }
    // Read in the same snapshot as eligibility; a task without a generation row is
    // returned without one, and a restricted issuer then refuses to mint for it.
    const generationField = taskId => {
      const generation = currentTaskAuthorizationGeneration(repository.database, taskId);
      return generation === null ? {} : { authorizationGeneration: generation };
    };
    try {
      // Synchronous reads share one SQLite snapshot with no intervening await.
      // Exact-task queries never invoke the project catalog or expose siblings.
      const result = processing.transaction(() => {
        const project = processing.getProject(projectId);
        if (!project || project.status !== 'active') return null;
        if (validateExclusions && !processing.validateProjectExclusions(project.id, exclusions)) return null;
        const page = taskId === undefined
          ? processing.listActivePublishedProjectTasksPage(projectId, { limit: Number(limit), cursor: cursor || null, strictPublished: true, exclusions })
          : { items: [processing.getActivePublishedProjectTask(projectId, taskId, { strictPublished: true, exclusions })].filter(Boolean), nextCursor: null };
        if (taskId !== undefined && page.items.length !== 1) return null;
        // Paths are read only for the already-visible tasks on this page, in the same snapshot.
        const folderPaths = processing.clientTaskFolderPaths(project.id, page.items.map(task => task.taskId));
        return { schemaVersion: 1, project: { id: project.id, displayName: project.displayName },
          tasks: page.items.map(task => ({ id: task.taskId, displayName: task.taskDisplayName,
            modelId: task.modelId, modelVersionId: task.modelVersionId,
            modelTitle: task.modelDisplayName, publishedAt: task.publishedAt,
            folderPath: folderPaths.get(task.taskId) || [],
            ...generationField(task.taskId) })), nextCursor: page.nextCursor };
      });
      return result ? res.json(result) : res.status(404).json({ error: 'Published delivery unavailable', code: 'delivery_unavailable' });
    } catch (error) {
      if (error.code === 'invalid_cursor') return res.status(400).json({ error: 'Invalid catalog cursor', code: 'invalid_catalog_query' });
      return res.status(503).json({ error: 'Client delivery catalog unavailable', code: 'catalog_unavailable' });
    }
  });
  router.get('/api/v1/client-delivery-projects', requireService(repository), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { q = '', cursor, limit = '50' } = req.query;
    if (Object.keys(req.query).some(key => !['q', 'cursor', 'limit'].includes(key))
      || typeof q !== 'string' || q.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(q)
      || typeof limit !== 'string' || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50
      || (cursor !== undefined && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{8,2048}$/.test(cursor))))
      return res.status(400).json({ error: 'Invalid client delivery project query', code: 'invalid_catalog_query' });
    if (cursor !== undefined) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { /* Invalid below. */ }
      if (!decoded || Object.keys(decoded).sort().join(',') !== 'createdAt,id' || !UUID.test(decoded.id)
        || typeof decoded.createdAt !== 'string' || decoded.createdAt.length > 40 || !Number.isFinite(Date.parse(decoded.createdAt)))
        return res.status(400).json({ error: 'Invalid catalog cursor', code: 'invalid_catalog_query' });
    }
    try {
      const result = processing.transaction(() => processing.listActivePublishedProjectsPage({
        q: q.trim(), cursor: cursor || null, limit: Number(limit),
      }));
      return res.json({ schemaVersion: 1,
        projects: result.items.map(project => ({ id: project.id, displayName: project.displayName })),
        nextCursor: result.nextCursor });
    } catch (error) {
      if (error.code === 'invalid_cursor') return res.status(400).json({ error: 'Invalid catalog cursor', code: 'invalid_catalog_query' });
      return res.status(503).json({ error: 'Client delivery catalog unavailable', code: 'catalog_unavailable' });
    }
  });
  return router;
}

module.exports = { createClientDeliveryCatalog };
