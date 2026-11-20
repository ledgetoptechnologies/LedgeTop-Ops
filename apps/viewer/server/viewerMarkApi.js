'use strict';

const { trackedRouter } = require('./httpRequestLifecycle');
const { getMeasurementPrincipal } = require('./measurementApi');
const { ViewerMarkRepository, markError } = require('./viewerMarkRepository');

function createViewerMarkApi(repository) {
  const router = trackedRouter();
  const marks = new ViewerMarkRepository(repository.database);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // The same explicit live bearer and verified individual identity used for private measurements.
    const principal = getMeasurementPrincipal(req, repository);
    if (!principal) return res.status(403).json({ code: 'private_marks_unavailable' });
    if (!['GET', 'HEAD'].includes(req.method)
      && repository.rateLimited(`viewer-mark-write:${principal.audience}:${principal.subject}`, 180, 60_000)) {
      return res.status(429).json({ code: 'mark_rate_limited' });
    }
    req.markPrincipal = principal;
    next();
  });
  router.get('/', (req, res) => res.json({ marks: marks.list(req.markPrincipal) }));
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
    if (!req.body || Object.keys(req.body).some(key => key !== 'revision')) throw markError('invalid_mark_delete');
    marks.delete(req.markPrincipal, req.params.id, req.body.revision);
    res.status(204).end();
  });
  router.use((error, _req, res, next) => {
    if (!error.status) return next(error);
    return res.status(error.status).json({ code: error.code });
  });
  return router;
}

module.exports = { createViewerMarkApi };
