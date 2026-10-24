'use strict';

const express = require('express');
const { requireService } = require('./serviceAuth');
const { ProcessingRepository } = require('./processingRepository');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createClientDeliveryCatalog(repository) {
  const router = express.Router();
  const processing = new ProcessingRepository(repository.database);
  router.get('/api/v1/client-delivery-catalog', requireService(repository), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { projectId, taskId, cursor, limit = '50' } = req.query;
    if (Object.keys(req.query).some(key => !['projectId', 'taskId', 'cursor', 'limit'].includes(key))
      || typeof projectId !== 'string' || !UUID.test(projectId)
      || (taskId !== undefined && (typeof taskId !== 'string' || !UUID.test(taskId)))
      || typeof limit !== 'string' || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50
      || (cursor !== undefined && (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{8,2048}$/.test(cursor)))
      || (taskId !== undefined && cursor !== undefined))
      return res.status(400).json({ error: 'Invalid client delivery catalog query', code: 'invalid_catalog_query' });
    if (cursor !== undefined) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { /* Invalid below. */ }
      if (!decoded || Object.keys(decoded).sort().join(',') !== 'createdAt,id' || !UUID.test(decoded.id)
        || typeof decoded.createdAt !== 'string' || decoded.createdAt.length > 40 || !Number.isFinite(Date.parse(decoded.createdAt)))
        return res.status(400).json({ error: 'Invalid catalog cursor', code: 'invalid_catalog_query' });
    }
    try {
      // Synchronous reads share one SQLite snapshot with no intervening await.
      // Exact-task queries never invoke the project catalog or expose siblings.
      const result = processing.transaction(() => {
        const project = processing.getProject(projectId);
        if (!project || project.status !== 'active') return null;
        const page = taskId === undefined
          ? processing.listActivePublishedProjectTasksPage(projectId, { limit: Number(limit), cursor: cursor || null, strictPublished: true })
          : { items: [processing.getActivePublishedProjectTask(projectId, taskId, { strictPublished: true })].filter(Boolean), nextCursor: null };
        if (taskId !== undefined && page.items.length !== 1) return null;
        return { schemaVersion: 1, project: { id: project.id, displayName: project.displayName },
          tasks: page.items.map(task => ({ id: task.taskId, displayName: task.taskDisplayName,
            modelId: task.modelId, modelVersionId: task.modelVersionId,
            modelTitle: task.modelDisplayName, publishedAt: task.publishedAt })), nextCursor: page.nextCursor };
      });
      return result ? res.json(result) : res.status(404).json({ error: 'Published delivery unavailable', code: 'delivery_unavailable' });
    } catch (error) {
      if (error.code === 'invalid_cursor') return res.status(400).json({ error: 'Invalid catalog cursor', code: 'invalid_catalog_query' });
      return res.status(503).json({ error: 'Client delivery catalog unavailable', code: 'catalog_unavailable' });
    }
  });
  return router;
}

module.exports = { createClientDeliveryCatalog };
