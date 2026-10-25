'use strict';

const crypto = require('crypto');
const express = require('express');
const auth = require('./auth');
const shareTokenVault = require('./shareTokenVault');
const { config } = require('./config');
const { requireService } = require('./serviceAuth');
const { encrypt, idempotent } = require('./serviceIdempotency');
const { publicDerivativeKind } = require('./processingSecurity');
const { receiptVerifiedLodProvenance, verifiedLodProvenance, viewerEligibleAssets } = require('./lodDerivativePolicy');
const { createMeasurementApi } = require('./measurementApi');
const { reviewedAssetUnitEvidence } = require('./measurementUnitEvidence');

const VIEWER_COOKIE = 'ltds_viewer';

function encodedAssetUrl(modelId, asset, assetToken = null) {
  if (!asset) return null;
  const relative = String(asset.relativePath || '').split(/[\\/]+/).map(encodeURIComponent).join('/');
  const prefix = assetToken
    ? `/session-assets/${encodeURIComponent(assetToken)}`
    : '/assets';
  return `${prefix}/${encodeURIComponent(modelId)}/${encodeURIComponent(asset.rootKey)}/${relative}`;
}

function toViewerConfig(model, { assetToken = null, assetFilter = null, sessionMode = 'published' } = {}) {
  if (!model || !model.activeVersion) return null;
  const verificationAssets = model.activeVersion.lodVerificationAssets || model.activeVersion.assets;
  const verifiedAssets = viewerEligibleAssets(model.activeVersion.metadata, verificationAssets);
  const verifiedAssetIds = new Set(verifiedAssets.map((asset) => asset.id));
  const eligibleAssets = verificationAssets === model.activeVersion.assets
    ? verifiedAssets
    : model.activeVersion.assets.filter((asset) => verifiedAssetIds.has(asset.id));
  // Validate the complete private asset set before review-session filtering.
  // Schema-v3 provenance binds the private OBJ proof asset, which must never
  // be exposed in the browser configuration but is still required to prove the
  // already-eligible tiles are authentic.
  const lodProvenance = verifiedLodProvenance(model.activeVersion.metadata, verifiedAssets);
  const serverVerifiedLodProvenance = receiptVerifiedLodProvenance(
    model.activeVersion.metadata,
    verifiedAssets,
    model.activeVersion.lodVerifierReceipt,
    model.activeVersion.id,
  );
  const visibleAssets = typeof assetFilter === 'function'
    ? eligibleAssets.filter(assetFilter)
    : eligibleAssets;
  const byKind = Object.fromEntries(visibleAssets.map((asset) => [asset.kind, asset]));
  const pointCloud = byKind.pointCloud;
  return {
    id: model.id,
    title: model.displayName,
    projectName: model.metadata.projectName || null,
    status: model.status,
    providerStatus: model.metadata.webodmStatus ?? null,
    statusLabel: String(model.status || '').toUpperCase(),
    available: model.activeVersion.status === 'ready'
      && (sessionMode === 'review' || model.status === 'ready'),
    provider: model.provider,
    georef: model.activeVersion.georef || {},
    pointCount: model.activeVersion.pointCount ?? null,
    lodProvenance,
    // The browser must not maintain a second, stale allowlist of converter
    // command or binary hashes. This marker is emitted only after the server
    // has validated the provenance against the exact registered GLB, OBJ and
    // tiles-manifest digests above. Legacy catalog responses do not receive
    // this authority marker and therefore retain the browser's fail-closed
    // validation path.
    lodProvenanceVerified: Boolean(serverVerifiedLodProvenance),
    // Display-only evidence is emitted only for an exact authorized registered
    // source. It does not authorize calculation or accept client unit claims.
    displayElevationEvidence: Object.fromEntries(['dsm', 'dtm'].flatMap(kind => {
      const evidence = reviewedAssetUnitEvidence(model.id, model.activeVersion.id, byKind[kind]);
      return evidence ? [[kind, { ...evidence, url: encodedAssetUrl(model.id, byKind[kind], assetToken) }]] : [];
    })),
    assets: {
      glb: encodedAssetUrl(model.id, byKind.glb, assetToken),
      tiles: encodedAssetUrl(model.id, byKind.tiles, assetToken),
      ept: encodedAssetUrl(model.id, byKind.ept, assetToken),
      obj: encodedAssetUrl(model.id, byKind.obj, assetToken),
      ortho: encodedAssetUrl(model.id, byKind.ortho, assetToken),
      dsm: encodedAssetUrl(model.id, byKind.dsm, assetToken),
      dtm: encodedAssetUrl(model.id, byKind.dtm, assetToken),
      shots: encodedAssetUrl(model.id, byKind.shots, assetToken),
      cameraPhotos: assetToken && byKind.shots
        ? `/session-camera-photos/${encodeURIComponent(assetToken)}/${encodeURIComponent(model.id)}`
        : null,
      pointCloud: encodedAssetUrl(model.id, pointCloud, assetToken),
      pointCloudFormat: pointCloud ? pointCloud.format : null,
    },
    activeVersion: {
      id: model.activeVersion.id,
      providerVersionId: model.activeVersion.providerVersionId,
      createdAt: model.activeVersion.createdAt,
      updatedAt: model.activeVersion.updatedAt,
    },
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

// A registered model can precede its first publishable version. Service
// catalogs describe that state without pretending it is a browser capability.
// Versioned records retain their established full response for compatibility.
function serviceCatalogModel(model) {
  if (model.activeVersion) return toViewerConfig(model);
  return {
    id: model.id,
    title: model.displayName,
    provider: model.provider,
    status: model.status,
    updatedAt: model.updatedAt,
    available: false,
    activeVersion: null,
  };
}

function publicShareSummary(share) {
  return {
    id: share.id,
    modelId: share.modelId,
    versionPolicy: share.versionPolicy,
    modelVersionId: share.modelVersionId,
    hasPassword: share.hasPassword,
    permissions: share.permissions,
    label: share.label,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
    expiresAt: share.expiresAt,
    displayUnits: share.displayUnits || config.defaultUnits,
    revokedAt: share.revokedAt,
    revokedBy: share.revokedBy,
    revokeReason: share.revokeReason,
    accessCount: share.accessCount,
    lastAccessedAt: share.lastAccessedAt,
    shareClass: share.shareClass || 'staff',
    sourceAuthorization: share.sourceAuthorization || null,
  };
}

function permissions(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    view: input.view !== false,
    measure: input.measure !== false,
    cameras: input.cameras !== false,
    download: input.download === true,
    // Service grant issuer attests that subject identifies one person, not an
    // account/company. Legacy client grants intentionally do not persist notes.
    ...(input.personalMeasurements === true ? { personalMeasurements: true } : {}),
  };
}

function validSubject(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}

function publishedSessionSourceAuthorization(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'id,type,version'
    || !['model_association', 'direct_client_grant'].includes(value.type)
    || typeof value.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.id)
    || !Number.isSafeInteger(value.version) || value.version < 1)
    return null;
  return { type: value.type, id: value.id, version: value.version };
}

function sameSourceAuthorization(left, right) {
  if (!left || !right) return left === null && right === null;
  return left.type === right.type && left.id === right.id && left.version === right.version;
}

function createApiV1(repository) {
  const router = express.Router();
  const serviceOnly = requireService(repository);
  router.use(require('./clientDeliveryCatalog').createClientDeliveryCatalog(repository));
  const idempotentService = idempotent(repository);
  router.use('/api/v1/measurements', createMeasurementApi(repository));
  if (config.publishedSessionSourceRevocationEnabled) repository.failClosedUnboundPublishedSessions({
    actorType: 'system',
    action: 'published_session.unbound_revoked',
    entityType: 'source_authorization',
  });

  function viewerToken(req) {
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return bearer ? bearer[1] : (req.cookies && req.cookies[VIEWER_COOKIE]);
  }

  function currentViewer(req) {
    const presented = presentedViewer(req);
    if (!presented || !repository.viewerSessionLive(presented.session)) return null;
    return presented;
  }

  // A fresh one-time grant is the authority for renewal. During that exact
  // redemption only, retain an expired (but never revoked) bearer so a tab
  // that was suspended can extend the same capability and keep every tile URL
  // valid. All ordinary Viewer endpoints continue to require a live session.
  function presentedViewer(req) {
    const token = viewerToken(req);
    if (!token) return null;
    const session = repository.getViewerSessionByHash(auth.hashToken(token));
    if (!session || session.revokedAt || session.permissions?.view === false) return null;
    return { token, session };
  }

  function modelForSession(session) {
    if (!repository.viewerSessionLive(session)) return null;
    if (session.sessionMode === 'review') {
      const candidate = repository.getModelVersion(session.modelId, session.modelVersionId);
      if (!candidate?.activeVersion || candidate.activeVersion.id !== session.modelVersionId) return null;
      return candidate;
    }
    const model = repository.getModel(session.modelId);
    return model?.status === 'ready' && model.activeVersionId === session.modelVersionId ? model : null;
  }

  function sendCurrentSession(_req, res, session, accessToken) {
    const model = modelForSession(session);
    if (!model)
      return res.status(404).json({ error: 'model version is no longer available' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      model: toViewerConfig(model, {
        assetToken: accessToken,
        assetFilter: session.sessionMode === 'review' ? (asset) => publicDerivativeKind(asset.kind) : null,
        sessionMode: session.sessionMode || 'published',
      }),
      permissions: session.permissions,
      sessionId: session.id,
      subject: session.subject,
      audience: session.audience,
      sessionMode: session.sessionMode || 'published',
      reviewAttemptId: session.reviewAttemptId || null,
      expiresAt: session.expiresAt,
      displayUnits: session.displayUnits || config.defaultUnits,
      accessToken,
      allowedEmbedOrigins: config.allowedEmbedOrigins,
    });
  }

  // Browser-facing endpoints use a one-time, short-lived grant. They never
  // accept or return the LTDS Ops service credential.
  router.post('/api/v1/sessions/redeem', (req, res) => {
    if (repository.rateLimited(`session-redeem:${req.ip}`, 30, 5 * 60 * 1000))
      return res.status(429).json({ error: 'too many attempts, try again later' });
    const grantId = req.body && req.body.grant;
    if (typeof grantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(grantId))
      return res.status(400).json({ error: 'invalid session grant' });
    const existing = presentedViewer(req);
    const grant = repository.redeemSessionGrant(grantId);
    if (!grant) return res.status(410).json({ error: 'session grant expired or already redeemed' });
    const authorizedUntilMs = Date.parse(grant.permissions.__authorizedUntil || '');
    const ttlMs = Math.min(
      config.viewerSessionTtlSeconds * 1000,
      Number.isFinite(authorizedUntilMs) ? authorizedUntilMs - Date.now() : config.viewerSessionTtlSeconds * 1000,
    );
    if (ttlMs <= 0) return res.status(410).json({ error: 'LTDS authorization has expired' });
    const modelVersionId = grant.modelVersionId || grant.permissions.__versionId;
    const target = {
      sessionMode: grant.sessionMode || 'published',
      reviewAttemptId: grant.reviewAttemptId || null,
      modelId: grant.modelId,
      modelVersionId,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      revokedAt: null,
    };
    const model = target.sessionMode === 'review'
      ? repository.getModelVersion(target.modelId, target.modelVersionId)
      : repository.getModel(target.modelId);
    const targetLive = target.sessionMode === 'review'
      ? repository.viewerSessionLive(target)
      : model?.status === 'ready' && model.activeVersionId === target.modelVersionId;
    if (!model || !targetLive)
      return res.status(404).json({ error: 'model not found' });
    const grantedPermissions = { ...grant.permissions };
    delete grantedPermissions.__authorizedUntil;
    delete grantedPermissions.__versionId;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    let accessToken;
    let session;
    const canRenew = existing
      && existing.session.modelId === grant.modelId
      && existing.session.modelVersionId === modelVersionId
      && existing.session.subject === grant.subject
      && existing.session.audience === grant.audience
      && existing.session.sessionMode === target.sessionMode
      && (existing.session.reviewAttemptId || null) === target.reviewAttemptId
      && sameSourceAuthorization(existing.session.sourceAuthorization, grant.sourceAuthorization);
    if (canRenew) {
      accessToken = existing.token;
      session = repository.renewViewerSession(existing.session.id, { permissions: grantedPermissions, displayUnits: grant.displayUnits || config.defaultUnits, expiresAt });
    } else {
      accessToken = crypto.randomBytes(32).toString('base64url');
      session = repository.createViewerSession({
        tokenHash: auth.hashToken(accessToken),
        modelId: grant.modelId,
        modelVersionId,
        reviewAttemptId: target.reviewAttemptId,
        sessionMode: target.sessionMode,
        sourceAuthorization: grant.sourceAuthorization,
        subject: grant.subject,
        audience: grant.audience,
        permissions: grantedPermissions,
        displayUnits: grant.displayUnits || config.defaultUnits,
        expiresAt,
      });
    }
    if (!session) return res.status(410).json({ error: 'viewer session could not be renewed' });
    res.cookie(VIEWER_COOKIE, accessToken, auth.cookieAttrs(req, { maxAge: ttlMs }));
    repository.audit({ actorType: grant.audience, actorId: grant.subject, action: 'session.redeemed', entityType: 'model', entityId: grant.modelId });
    return sendCurrentSession(req, res, session, accessToken);
  });

  router.get('/api/v1/sessions/current', (req, res) => {
    const current = currentViewer(req);
    if (!current) return res.status(401).json({ error: 'viewer session required' });
    return sendCurrentSession(req, res, current.session, current.token);
  });

  router.get('/api/v1/models', serviceOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ models: repository.listModels().map(serviceCatalogModel) });
  });

  router.get('/api/v1/models/:id', serviceOnly, (req, res) => {
    const model = repository.getModel(req.params.id);
    if (!model || model.status === 'unregistered') return res.status(404).json({ error: 'model not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ model: serviceCatalogModel(model) });
  });

  router.post('/api/v1/models/:id/sessions', serviceOnly, idempotentService, (req, res) => {
    const model = repository.getModel(req.params.id);
    if (!model || model.status !== 'ready' || !model.activeVersion)
      return res.status(404).json({ error: 'ready model not found' });
    const body = req.body || {};
    const sourceAuthorization = body.sourceAuthorization === undefined
      ? null
      : publishedSessionSourceAuthorization(body.sourceAuthorization);
    if (body.sourceAuthorization !== undefined && !sourceAuthorization)
      return res.status(400).json({ error: 'sourceAuthorization is invalid' });
    if (config.publishedSessionSourceRevocationEnabled && !sourceAuthorization)
      return res.status(400).json({ error: 'sourceAuthorization is required while published-session revocation is enabled' });
    if (!body.modelVersionId) return res.status(400).json({ error: 'modelVersionId is required' });
    if (body.modelVersionId !== model.activeVersionId)
      return res.status(409).json({ error: 'requested model version is not active' });
    if (!validSubject(body.subject)) return res.status(400).json({ error: 'subject is required' });
    if (body.audience !== 'ops' && body.audience !== 'client')
      return res.status(400).json({ error: 'audience must be ops or client' });
    const grantedPermissions = permissions(body.permissions);
    if (!grantedPermissions.view) return res.status(400).json({ error: 'view permission is required' });
    if (body.displayUnits !== undefined && body.displayUnits !== 'imperial' && body.displayUnits !== 'metric')
      return res.status(400).json({ error: 'displayUnits must be imperial or metric' });
    if (!body.authorizationExpiresAt) return res.status(400).json({ error: 'authorizationExpiresAt is required' });
    const requestedAuthorizationExpiry = Date.parse(body.authorizationExpiresAt);
    if (!Number.isFinite(requestedAuthorizationExpiry) || requestedAuthorizationExpiry <= Date.now())
      return res.status(400).json({ error: 'authorizationExpiresAt must be in the future' });
    const authorizedUntil = new Date(Math.min(
      requestedAuthorizationExpiry,
      Date.now() + config.viewerSessionTtlSeconds * 1000,
    )).toISOString();
    const grantExpiresAt = new Date(Math.min(
      Date.parse(authorizedUntil),
      Date.now() + config.sessionGrantTtlSeconds * 1000,
    )).toISOString();
    let grant;
    try {
      grant = repository.createSessionGrantAudited({
        modelId: model.id,
        modelVersionId: model.activeVersionId,
        sessionMode: 'published',
        sourceAuthorization,
        subject: body.subject,
        audience: body.audience,
        permissions: {
          ...grantedPermissions,
          __authorizedUntil: authorizedUntil,
          __versionId: model.activeVersionId,
        },
        displayUnits: body.displayUnits || config.defaultUnits,
        expiresAt: grantExpiresAt,
      }, {
        actorType: 'service',
        actorId: req.servicePrincipal.keyId,
        action: 'session.created',
        entityType: 'model',
        entityId: model.id,
        details: { audience: body.audience, subject: body.subject },
      });
    } catch (error) {
      if (error?.code === 'source_authorization_revoked')
        return res.status(409).json({ error: 'sourceAuthorization is revoked' });
      throw error;
    }
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      grant: grant.id,
      grantExpiresAt,
      sessionTtlSeconds: config.viewerSessionTtlSeconds,
      modelVersionId: model.activeVersionId,
      authorizationExpiresAt: authorizedUntil,
      redeemUrl: `${base}/api/v1/sessions/redeem`,
      embedUrl: `${base}/session/${encodeURIComponent(grant.id)}`,
    });
  });

  function publishedSessionSourceRevocationEnabled(req, res, next) {
    if (!config.publishedSessionSourceRevocationEnabled && req.body?.sourceAuthorization?.type !== 'direct_client_grant') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'published-session source revocation is disabled' });
    }
    return next();
  }

  router.delete('/api/v1/published-sessions/source-authorization', serviceOnly,
    publishedSessionSourceRevocationEnabled, idempotentService, (req, res) => {
      const body = req.body || {};
      const sourceAuthorization = Object.keys(body).join(',') === 'sourceAuthorization'
        ? publishedSessionSourceAuthorization(body.sourceAuthorization)
        : null;
      if (!sourceAuthorization)
        return res.status(400).json({ error: 'sourceAuthorization is invalid' });
      const revoked = repository.revokePublishedSessionsBySourceAuthorization({
        sourceAuthorization,
        idempotency: {
          keyId: req.servicePrincipal.keyId,
          idempotencyKey: req.get('Idempotency-Key'),
          encrypt,
        },
        audit: {
          actorType: 'service',
          actorId: req.servicePrincipal.keyId,
          action: 'published_session.source_authorization_revoked',
          entityType: 'source_authorization',
        },
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(revoked);
    });

  router.get('/api/v1/models/:id/shares', serviceOnly, (req, res) => {
    const model = repository.getModel(req.params.id);
    if (!model) return res.status(404).json({ error: 'model not found' });
    res.json({ shares: repository.listPublicShares(model.id).map(publicShareSummary) });
  });

  router.post('/api/v1/models/:id/shares', serviceOnly, idempotentService, async (req, res, next) => {
    try {
      const model = repository.getModel(req.params.id);
      if (!model || model.status !== 'ready') return res.status(404).json({ error: 'ready model not found' });
      const body = req.body || {};
      const shareClass=body.shareClass===undefined?'staff':body.shareClass,source=body.sourceAuthorization;if(!['staff','client'].includes(shareClass))return res.status(400).json({error:'shareClass must be staff or client'});if(shareClass==='staff'&&source!==undefined&&source!==null)return res.status(400).json({error:'staff shares cannot include sourceAuthorization'});if(shareClass==='client'){if(!config.clientViewerSharesEnabled)return res.status(503).json({error:'client Viewer shares are disabled'});if(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).sort().join(',')!=='expiresAt,id,subject,type,version'||source.type!=='client_grant'||typeof source.id!=='string'||!source.id||!Number.isSafeInteger(source.version)||source.version<1||typeof source.subject!=='string'||!source.subject||source.subject.length>512||(source.expiresAt!==null&&(!Number.isFinite(Date.parse(source.expiresAt))||Date.parse(source.expiresAt)<=Date.now())))return res.status(400).json({error:'sourceAuthorization is invalid'});}
      if (body.versionPolicy === 'pinned') {
        return res.status(422).json({ error: 'pinned shares are not supported until pinned-version asset resolution is available' });
      }
      let passwordHash = null;
      if (body.password !== undefined && body.password !== '') {
        if (String(body.password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
        passwordHash = await auth.hashPassword(String(body.password));
      }
      let expiresAt = null;
      if (body.expiresAt !== undefined && body.expiresAt !== null) {
        const parsed = Date.parse(body.expiresAt);
        if (!Number.isFinite(parsed) || parsed <= Date.now()) return res.status(400).json({ error: 'expiresAt must be in the future' });
        expiresAt = new Date(parsed).toISOString();
      }
      if(shareClass==='client'&&source.expiresAt!==null&&(expiresAt===null||Date.parse(expiresAt)>Date.parse(source.expiresAt)))return res.status(400).json({error:'client share expiry cannot exceed source authorization'});
      const { token, tokenHash } = auth.newShareToken();
      if (body.displayUnits !== undefined && body.displayUnits !== 'imperial' && body.displayUnits !== 'metric')
        return res.status(400).json({ error: 'displayUnits must be imperial or metric' });
      const share = repository.createPublicShare({
        modelId: model.id,
        versionPolicy: 'latest',
        modelVersionId: null,
        publicIdHash: tokenHash,
        tokenCiphertext: shareClass==='staff'?shareTokenVault.seal(token,tokenHash):null,
        passwordHash,
        permissions: permissions(body.permissions),
        label: body.label ? String(body.label).slice(0, 120) : null,
        createdBy: body.createdBy ? String(body.createdBy).slice(0, 200) : req.servicePrincipal.keyId,
        expiresAt,
        displayUnits: body.displayUnits || config.defaultUnits,
        shareClass,
        sourceAuthorization:shareClass==='client'?source:null,
      });
      repository.audit({ actorType: 'service', actorId: req.servicePrincipal.keyId, action: 'share.created', entityType: 'share', entityId: share.id, details: { modelId: model.id } });
      const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        share: publicShareSummary(share),
        token,
        viewUrl: `${base}/view/${token}`,
        embedUrl: `${base}/embed/${token}`,
      });
    } catch (error) { next(error); }
  });

  router.delete('/api/v1/shares/:id', serviceOnly, idempotentService, (req, res) => {
    const share = repository.getPublicShare(req.params.id);
    if (!share) return res.status(404).json({ error: 'share not found' });
    const revoked = repository.revokePublicShare(share.id, {
      actorId: req.servicePrincipal.keyId,
      reason: req.body && req.body.reason ? req.body.reason : 'revoked',
    });
    repository.audit({ actorType: 'service', actorId: req.servicePrincipal.keyId, action: 'share.revoked', entityType: 'share', entityId: share.id });
    res.json({ share: publicShareSummary(revoked) });
  });

  return router;
}

module.exports = { VIEWER_COOKIE, createApiV1, encodedAssetUrl, permissions, publicShareSummary, toViewerConfig };
