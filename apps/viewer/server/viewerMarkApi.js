'use strict';

const { config } = require('./config');
const { trackedRouter } = require('./httpRequestLifecycle');
const { getMeasurementPrincipal } = require('./measurementApi');
const { ViewerMarkRepository, RECOVERY_DAYS, markError } = require('./viewerMarkRepository');

// Same explicit bearer and live model access as personal measurements. Each person
// reads and changes their own marks; staff also read (never change) client marks
// shared with project staff (SERVED_SHARING). A client
// session without a verified individual identity (a shared company login) has no
// person to own marks: it gets an empty list and everything else is refused.
// The app's JSON parser limit, so the page can say what is too large before sending it.
const requestLimit = () => (config.processingPlatformEnabled ? config.uploadMaxManifestBytes : 100 * 1024);
// A page cursor: the time and id of the last mark on the page before.
const CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)~([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

function createViewerMarkApi(repository, { visibility, maxRequestBytes = requestLimit() } = {}) {
  const router = trackedRouter();
  const marks = new ViewerMarkRepository(repository.database, { visibility });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const principal = getMeasurementPrincipal(req, repository, { allowTransient: true });
    if (!principal) return res.status(403).json({ code: 'marks_unavailable' });
    if (!principal.personalPersistence) {
      if (req.method === 'GET' && req.path === '/') {
        return res.json({ marks: [], categories: [], starters: [], capabilities: { write: false, staff: false, visibility: ['private'] } });
      }
      return res.status(403).json({ code: 'mark_identity_required' });
    }
    const batchStatus = req.method === 'POST' && /^\/batch\/status\/?$/.test(req.path);
    const reading = ['GET', 'HEAD'].includes(req.method) || batchStatus;
    if (repository.rateLimited(`viewer-mark-${reading ? 'read' : 'write'}:${principal.audience}:${principal.subject}`, reading ? 240 : 180, 60_000)) {
      return res.status(429).json({ code: 'mark_rate_limited' });
    }
    req.markPrincipal = principal;
    if (!batchStatus) marks.touchAccount(principal);
    next();
  });
  const revisionOnly = body => {
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => key !== 'revision')) throw markError('invalid_mark_delete');
    return body.revision;
  };

  router.get('/', (req, res) => {
    const principal = req.markPrincipal;
    res.json({
      marks: marks.list(principal), categories: marks.categories(principal), starters: marks.starters(principal),
      capabilities: { write: true, staff: principal.audience === 'ops',
        visibility: marks.visibility[principal.audience], recoveryDays: RECOVERY_DAYS,
        shared: marks.readableChoices(principal).length > 0, maxRequestBytes },
    });
  });
  // What others share with this person, a page at a time.
  router.get('/shared', (req, res) => {
    const after = req.query.after === undefined ? null : typeof req.query.after === 'string' && CURSOR.exec(req.query.after);
    if (after === false || (req.query.after !== undefined && !after)) throw markError('invalid_mark_page');
    res.json(marks.sharedPage(req.markPrincipal, after && { at: after[1], id: after[2] }));
  });
  router.get('/deleted', (req, res) => res.json({ marks: marks.deleted(req.markPrincipal) }));
  router.get('/audiences', (req, res) => res.json({ audiences: marks.audiences(req.markPrincipal) }));
  router.post('/batch', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(key => !['marks', 'categories'].includes(key))) throw markError('invalid_mark_batch');
    res.status(201).json(marks.createMany(req.markPrincipal, req.body));
  });
  router.post('/batch/delete', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(key => key !== 'marks')) throw markError('invalid_mark_batch');
    marks.deleteMany(req.markPrincipal, req.body.marks);
    res.status(204).end();
  });
  router.post('/batch/status', (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).some(key => key !== 'ids')) throw markError('invalid_mark_batch');
    res.json({ reservedIds: marks.reservedImportIds(req.markPrincipal, req.body.ids) });
  });
  router.post('/categories', (req, res) => {
    const result = marks.createCategory(req.markPrincipal, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  });
  router.post('/categories/starter', (req, res) => {
    const result = marks.createStarter(req.markPrincipal, req.body);
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
  router.post('/:id/restore', (req, res) => res.json({ mark: marks.restore(req.markPrincipal, req.params.id, revisionOnly(req.body)) }));
  router.delete('/:id', (req, res) => {
    const { permanent = false, ...body } = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof permanent !== 'boolean') throw markError('invalid_mark_delete');
    marks.delete(req.markPrincipal, req.params.id, revisionOnly(body), { permanent });
    res.status(204).end();
  });
  router.use((error, _req, res, next) => {
    if (!error.status) return next(error);
    return res.status(error.status).json({ code: error.code });
  });
  return router;
}

module.exports = { createViewerMarkApi };
