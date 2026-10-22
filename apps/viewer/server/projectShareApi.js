'use strict';

const path = require('node:path');
const express = require('express');
const auth = require('./auth');
const { config } = require('./config');
const { toViewerConfig } = require('./apiV1');
const { publicDerivativeKind } = require('./processingSecurity');

const PROJECT_SHARE_COOKIE = 'ltds_project_share';
const PROJECT_SHARE_SESSION_TTL_MS = 60 * 60 * 1000;

function pageQuery(req) {
  const raw = String(req.query.limit || '50');
  if (!/^\d{1,2}$/.test(raw)) return null;
  const limit = Number(raw);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;
  if (limit < 1 || limit > 50 || (cursor && !/^[A-Za-z0-9_-]{8,2048}$/.test(cursor))) return null;
  return { limit, cursor };
}

function createProjectShareApi({ repository, processing }) {
  const router = express.Router();

  function rateKey(kind, token, ip) {
    return `${kind}:${auth.hashToken(String(token || '').normalize('NFKC'))}:${ip}`;
  }

  function bootstrapLimited(req) {
    return repository.rateLimited(`project-share-bootstrap-ip:${req.ip}`, 120, 5 * 60_000)
      || repository.rateLimited(rateKey('project-share-bootstrap', req.params.token, req.ip), 60, 5 * 60_000);
  }

  function taskLimited(req) {
    return repository.rateLimited(rateKey('project-share-task', req.params.token, req.ip), 120, 5 * 60_000);
  }

  function lookup(token) {
    return repository.getProjectShareByHash(auth.hashToken(String(token || '')));
  }

  function liveProjectShare(token) {
    const share = lookup(token);
    if (!repository.projectShareLive(share)) return { share, status: share ? 410 : 404 };
    const project = processing.getProject(share.projectId);
    if (!project || project.status !== 'active') return { share, project, status: 410 };
    return { share, project, status: 200 };
  }

  function unlocked(req, share) {
    if (!share.passwordHash) return true;
    const signed = req.cookies?.[PROJECT_SHARE_COOKIE];
    const payload = signed ? auth.verify(signed) : null;
    return Boolean(payload && payload.kind === 'project-share'
      && payload.shareId === share.id && payload.projectId === share.projectId);
  }

  function issueSession(req, res, share) {
    const remaining = share.expiresAt ? Date.parse(share.expiresAt) - Date.now() : PROJECT_SHARE_SESSION_TTL_MS;
    const ttl = Math.max(1, Math.min(PROJECT_SHARE_SESSION_TTL_MS, remaining));
    res.cookie(PROJECT_SHARE_COOKIE, auth.sign({
      kind: 'project-share', shareId: share.id, projectId: share.projectId,
    }, ttl), auth.cookieAttrs(req, { maxAge: ttl }));
  }

  function catalog(req, res, context, { recordAccess = true } = {}) {
    const page = pageQuery(req);
    if (!page) return res.status(400).json({ error: 'invalid page', code: 'invalid_page' });
    let result;
    try { result = processing.listActivePublishedProjectTasksPage(context.project.id, page); }
    catch { return res.status(400).json({ error: 'invalid page', code: 'invalid_page' }); }
    if (recordAccess) repository.recordProjectShareAccess(context.share.id);
    issueSession(req, res, context.share);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      project: { id: context.project.id, displayName: context.project.displayName },
      tasks: result.items.map((item) => ({
        id: item.taskId,
        displayName: item.taskDisplayName,
        modelTitle: item.modelDisplayName,
        publishedAt: item.publishedAt,
      })),
      nextCursor: result.nextCursor,
      permissions: context.share.permissions,
      displayUnits: context.share.displayUnits || context.project.defaultUnits || config.defaultUnits,
      shareExpiresAt: context.share.expiresAt || null,
    });
  }

  router.get('/api/project-share/:token', (req, res) => {
    if (bootstrapLimited(req)) return res.status(429).json({ error: 'too many requests', code: 'rate_limited' });
    const context = liveProjectShare(req.params.token);
    if (context.status === 404) return res.status(404).json({ error: 'link not found', code: 'link_not_found' });
    if (context.status !== 200) return res.status(410).json({ error: 'link expired, revoked, or unavailable', code: 'link_unavailable' });
    if (!unlocked(req, context.share)) return res.status(401).set('Cache-Control', 'no-store').json({ requiresPassword: true });
    return catalog(req, res, context);
  });

  router.post('/api/project-share/:token/unlock', async (req, res) => {
    if (repository.rateLimited(`project-share-unlock-ip:${req.ip}`, 40, 5 * 60_000)
      || repository.rateLimited(rateKey('project-share-unlock', req.params.token, req.ip), 8, 5 * 60_000)) {
      return res.status(429).json({ error: 'too many attempts, try again later', code: 'rate_limited' });
    }
    const context = liveProjectShare(req.params.token);
    if (context.status === 404) return res.status(404).json({ error: 'link not found', code: 'link_not_found' });
    if (context.status !== 200) return res.status(410).json({ error: 'link expired, revoked, or unavailable', code: 'link_unavailable' });
    if (!context.share.passwordHash) return res.status(400).json({ error: 'this link does not require a password', code: 'password_not_required' });
    if (!await auth.verifyPassword(String(req.body?.password || ''), context.share.passwordHash)) {
      return res.status(401).json({ error: 'incorrect password', code: 'incorrect_password' });
    }
    return catalog(req, res, context);
  });

  router.get('/api/project-share/:token/tasks/:taskId', (req, res) => {
    if (taskLimited(req)) return res.status(429).json({ error: 'too many requests', code: 'rate_limited' });
    const context = liveProjectShare(req.params.token);
    if (context.status === 404) return res.status(404).json({ error: 'link not found', code: 'link_not_found' });
    if (context.status !== 200) return res.status(410).json({ error: 'link expired, revoked, or unavailable', code: 'link_unavailable' });
    if (!unlocked(req, context.share)) return res.status(401).set('Cache-Control', 'no-store').json({ requiresPassword: true });
    const selected = processing.getActivePublishedProjectTask(context.project.id, req.params.taskId);
    const model = selected ? repository.getModel(selected.modelId) : null;
    if (!selected || !model || model.activeVersion?.id !== selected.modelVersionId) {
      return res.status(404).json({ error: 'published task not found', code: 'published_task_not_found' });
    }
    const publicAssets = model.activeVersion.assets.filter((asset) => asset.published && publicDerivativeKind(asset.kind));
    const integrityReady = publicAssets.length > 0 && publicAssets.every((asset) => asset.sha256
      && (!['ept', 'tiles'].includes(asset.kind)
        || (asset.manifestSha256 && repository.getModelAssetFile(asset.id, path.posix.basename(asset.relativePath)))));
    if (!integrityReady) return res.status(409).json({ error: 'published assets are not ready', code: 'asset_integrity_not_ready' });
    const remaining = context.share.expiresAt ? Date.parse(context.share.expiresAt) - Date.now() : PROJECT_SHARE_SESSION_TTL_MS;
    const ttl = Math.max(1, Math.min(PROJECT_SHARE_SESSION_TTL_MS, remaining));
    const assetToken = auth.sign({
      kind: 'project-share-asset',
      shareId: context.share.id,
      projectId: context.project.id,
      taskId: selected.taskId,
      modelId: selected.modelId,
      modelVersionId: selected.modelVersionId,
    }, ttl);
    const viewer = toViewerConfig(model, {
      assetToken,
      assetFilter: (asset) => asset.published && publicDerivativeKind(asset.kind),
    });
    issueSession(req, res, context.share);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ...viewer,
      task: { id: selected.taskId, displayName: selected.taskDisplayName },
      permissions: context.share.permissions,
      displayUnits: context.share.displayUnits || context.project.defaultUnits || config.defaultUnits,
      shareExpiresAt: context.share.expiresAt || null,
    });
  });

  return router;
}

module.exports = {
  PROJECT_SHARE_COOKIE,
  PROJECT_SHARE_SESSION_TTL_MS,
  createProjectShareApi,
};
