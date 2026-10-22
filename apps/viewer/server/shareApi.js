'use strict';

const express = require('express');
const store = require('./store');
const shareStore = require('./shareStore');
const auth = require('./auth');
const {revisionMatches,assetAllowed}=require('./publicSharePolicy');
const { requireAdmin } = require('./adminAuth');
const { toClientConfig } = require('./api');
const { config } = require('./config');
const { toViewerConfig } = require('./apiV1');
let { sourceAuthorizationValidator } = require('./sourceAuthorization');

const SHARE_COOKIE = 'ltds_share';
const SHARE_SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes; revocation is still checked live (see below)

const router = express.Router();
let canonicalRepository = null;

function setRepository(repository) {
  canonicalRepository = repository;
}
function setSourceAuthorizationValidator(validator){sourceAuthorizationValidator=validator;}

function shareSummary(s) {
  return {
    id: s.id,
    active: s.active,
    hasPassword: !!s.passwordHash,
    expiresAt: s.expiresAt || null,
    permissions: s.permissions,
    createdAt: s.createdAt,
    lastAccessedAt: s.lastAccessedAt,
    accessCount: s.accessCount || 0,
  };
}

function issueShareSession(req, res, share) {
  const cookieVal = auth.sign({
    shareId: share.id,
    shareRevision: share.authorizationRevision||0,
    ...(share.modelId ? { modelId: share.modelId } : { viewerProjectId: share.viewerProjectId }),
  }, SHARE_SESSION_TTL_MS);
  res.cookie(SHARE_COOKIE, cookieVal, auth.cookieAttrs(req, { maxAge: SHARE_SESSION_TTL_MS }));
}

function hasUnlockedSession(req, share) {
  const cookieVal = req.cookies && req.cookies[SHARE_COOKIE];
  const payload = cookieVal ? auth.verify(cookieVal) : null;
  return !!(payload && payload.shareId === share.id && revisionMatches(share,payload));
}

function sharedViewerConfig(project, share) {
  const assetToken = auth.sign({
    kind: 'share-asset',
    shareId: share.id,
    shareRevision: share.authorizationRevision||0,
    ...(share.modelId ? { modelId: share.modelId } : { viewerProjectId: share.viewerProjectId }),
  }, SHARE_SESSION_TTL_MS);
  if (share.modelId) return toViewerConfig(project, { assetToken,assetFilter:asset=>assetAllowed(share,asset.kind) });
  const result = toClientConfig(project);
  const prefix = `/session-assets/${encodeURIComponent(assetToken)}`;
  for (const [kind, value] of Object.entries(result.assets || {})) {
    if (kind !== 'pointCloudFormat' && typeof value === 'string' && value.startsWith('/assets/')) {
      result.assets[kind] = `${prefix}${value.slice('/assets'.length)}`;
    }
  }
  return result;
}

// ── Admin: create / list / revoke share links for a project ──────────────
router.post('/api/models/:id/share-links', requireAdmin, async (req, res) => {
  const project = store.getById(req.params.id);
  if (!project || !project.available) return res.status(404).json({ error: 'model not found' });

  const body = req.body || {};
  const { token, tokenHash } = auth.newShareToken();

  let passwordHash = null;
  if (body.password) {
    if (String(body.password).length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
    passwordHash = await auth.hashPassword(String(body.password));
  }

  let expiresAt = null;
  const days = Number(body.expiresDays);
  if (Number.isFinite(days) && days > 0) {
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  const permissions = {
    measure: !(body.permissions && body.permissions.measure === false),
    cameras: !(body.permissions && body.permissions.cameras === false),
  };

  const share = shareStore.create({ viewerProjectId: project.id, tokenHash, passwordHash, expiresAt, permissions });
  const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...shareSummary(share),
    // The raw token is only ever returned here, at creation time.
    token,
    viewUrl: `${base}/view/${token}`,
    embedUrl: `${base}/embed/${token}`,
  });
});

router.get('/api/models/:id/share-links', requireAdmin, (req, res) => {
  const shares = shareStore.getAllForProject(req.params.id)
    .map(shareSummary)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json(shares);
});

router.delete('/api/share-links/:id', requireAdmin, (req, res) => {
  const share = shareStore.getById(req.params.id);
  if (!share) return res.status(404).json({ error: 'not found' });
  shareStore.update(share.id, { active: false });
  res.json({ ok: true });
});

// ── Public: validate a token / unlock a password-protected one ───────────
router.get('/api/share/:token', async (req, res) => {
  const tokenHash = auth.hashToken(req.params.token);
  const legacyShare = shareStore.getByTokenHash(tokenHash);
  const share = (canonicalRepository && canonicalRepository.getPublicShareByHash(tokenHash)) || legacyShare;
  if (!share) return res.status(404).json({ error: 'link not found' });
  const live = share.modelId ? canonicalRepository.publicShareLive(share) : shareStore.isLive(share);
  if (!live) return res.status(410).json({ error: 'link expired or revoked' });
  if (!await sourceAuthorizationValidator.allows(share)) return res.status(410).json({ error: 'link authorization is no longer active' });

  const project = share.modelId ? canonicalRepository.getModel(share.modelId) : store.getById(share.viewerProjectId);
  const available = share.modelId ? project && project.status === 'ready' : project && project.available;
  if (!available) return res.status(404).json({ error: 'model not found' });

  if (share.passwordHash && !hasUnlockedSession(req, share)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).json({ requiresPassword: true });
  }

  if (share.modelId) canonicalRepository.recordPublicShareAccess(share.id);
  else shareStore.recordAccess(share.id);
  issueShareSession(req, res, share);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...sharedViewerConfig(project, share), permissions: share.permissions, displayUnits: share.displayUnits || config.defaultUnits, shareExpiresAt: share.expiresAt || null });
});

function shareUnlockRateKey(token,ip){return `share-unlock:${auth.hashToken(String(token||'').normalize('NFKC'))}:${ip}`;}
router.post('/api/share/:token/unlock', async (req, res) => {
  if ((canonicalRepository?.rateLimited(shareUnlockRateKey(req.params.token,req.ip), 8, 5 * 60 * 1000)) || (!canonicalRepository && auth.rateLimited(shareUnlockRateKey(req.params.token,req.ip), 8, 5 * 60 * 1000))) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  const tokenHash = auth.hashToken(req.params.token);
  const legacyShare = shareStore.getByTokenHash(tokenHash);
  const share = (canonicalRepository && canonicalRepository.getPublicShareByHash(tokenHash)) || legacyShare;
  if (!share) return res.status(404).json({ error: 'link not found' });
  const live = share.modelId ? canonicalRepository.publicShareLive(share) : shareStore.isLive(share);
  if (!live) return res.status(410).json({ error: 'link expired or revoked' });
  if (!await sourceAuthorizationValidator.allows(share)) return res.status(410).json({ error: 'link authorization is no longer active' });
  if (!share.passwordHash) return res.status(400).json({ error: 'this link does not require a password' });

  const ok = await auth.verifyPassword(String((req.body && req.body.password) || ''), share.passwordHash);
  if (!ok) return res.status(401).json({ error: 'incorrect password' });

  const project = share.modelId ? canonicalRepository.getModel(share.modelId) : store.getById(share.viewerProjectId);
  const available = share.modelId ? project && project.status === 'ready' : project && project.available;
  if (!available) return res.status(404).json({ error: 'model not found' });

  if (share.modelId) canonicalRepository.recordPublicShareAccess(share.id);
  else shareStore.recordAccess(share.id);
  issueShareSession(req, res, share);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...sharedViewerConfig(project, share), permissions: share.permissions, displayUnits: share.displayUnits || config.defaultUnits, shareExpiresAt: share.expiresAt || null });
});

module.exports = router;
module.exports.SHARE_COOKIE = SHARE_COOKIE;
module.exports.setRepository = setRepository;
module.exports.setSourceAuthorizationValidator = setSourceAuthorizationValidator;
module.exports.sharedViewerConfig = sharedViewerConfig;
module.exports.shareUnlockRateKey = shareUnlockRateKey;
