'use strict';

const { trackedRouter } = require('./httpRequestLifecycle');
const { getMeasurementPrincipal } = require('./measurementApi');
const { ViewerMarkRepository, markError } = require('./viewerMarkRepository');

// Same explicit bearer and live model access as personal measurements, and the
// same rule: each person reads and changes their own marks (OWNER_ONLY). A client
// session without a verified individual identity (a shared company login) has no
// person to own marks: it gets an empty list and everything else is refused.
function createViewerMarkApi(repository, { visibility } = {}) {
  const router = trackedRouter();
  const marks = new ViewerMarkRepository(repository.database, { visibility });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const principal = getMeasurementPrincipal(req, repository, { allowTransient: true });
    if (!principal) return res.status(403).json({ code: 'marks_unavailable' });
    if (!principal.personalPersistence) {
      if (req.method === 'GET' && req.path === '/') {
        return res.json({ marks: [], categories: [], capabilities: { write: false, staff: false, visibility: ['private'] } });
      }
      return res.status(403).json({ code: 'mark_identity_required' });
    }
    const reading = ['GET', 'HEAD'].includes(req.method);
    if (!reading && repository.rateLimited(`viewer-mark-write:${principal.audience}:${principal.subject}`, 180, 60_000)) {
      return res.status(429).json({ code: 'mark_rate_limited' });
    }
    req.markPrincipal = principal;
    marks.touchAccount(principal);
    next();
  });
  const revisionOnly = body => {
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => key !== 'revision')) throw markError('invalid_mark_delete');
    return body.revision;
  };

  router.get('/', (req, res) => {
    const principal = req.markPrincipal;
    res.json({
      marks: marks.list(principal), categories: marks.categories(principal),
      capabilities: { write: true, staff: principal.audience === 'ops',
        visibility: marks.visibility[principal.audience] },
    });
  });
  router.get('/audiences', (req, res) => res.json({ audiences: marks.audiences(req.markPrincipal) }));
  router.post('/batch', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(key => key !== 'marks')) throw markError('invalid_mark_batch');
    res.status(201).json({ marks: marks.createMany(req.markPrincipal, req.body.marks) });
  });
  router.post('/categories', (req, res) => {
    const result = marks.createCategory(req.markPrincipal, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.put('/categories/:id', (req, res) => res.json({ category: marks.updateCategory(req.markPrincipal, req.params.id, req.body) }));
  router.delete('/categories/:id', (req, res) => {
    marks.deleteCategory(req.markPrincipal, req.params.id, revisionOnly(req.body));
    res.status(204).end();
  });
  router.get('/:id', (req, res) => {
    const mark = marks.get(req.markPrincipal, req.params.id);
    if (!mark) throw markError('mark_not_found', 404);
    res.json({ mark });
  });
  router.post('/', (req, res) => {
    const result = marks.create(req.markPrincipal, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.put('/:id', (req, res) => res.json({ mark: marks.update(req.markPrincipal, req.params.id, req.body) }));
  router.delete('/:id', (req, res) => {
    marks.delete(req.markPrincipal, req.params.id, revisionOnly(req.body));
    res.status(204).end();
  });
  router.use((error, _req, res, next) => {
    if (!error.status) return next(error);
    return res.status(error.status).json({ code: error.code });
  });
  return router;
}

module.exports = { createViewerMarkApi };
