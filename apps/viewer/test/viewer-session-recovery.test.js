'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMeasurementDraftRecovery } = require('../measurement-draft-recovery.mjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'measurement-workspace.mjs'), 'utf8');
const REQUEST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function fixture({ controller = true } = {}) {
  const timers = new Map(), posts = [], resets = [], measurements = {invalidations:0,installs:0,invalidated:false,displayAborts:0,records:new Map([['private','geometry']])};
  let timerId = 0;
  const window = {};
  window.parent = window;
  const session = { sessionId: 'session-id', sessionMode: 'published', accessToken: 'private-token',subject:'person-one',audience:'ops',permissions:{view:true,measure:true},
    model: { id: 'model-one',activeVersion:{id:'version-one'} }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const context = vm.createContext({
    createMeasurementDraftRecovery,
    window, VIEW_MODE: 'session', reviewSessionChannel: controller ? { postMessage: value => posts.push(value) } : null,
    REVIEW_CONTROLLER_ID: REQUEST,
    activeViewerSession: session, sessionAccessGeneration: 0, PROJECT: session.model, TILES_URL: '/stable/tileset.json', EPT_URL: '/stable/ept.json',
    sessionStorage: { setItem() {} }, SESSION_STORAGE_PREFIX: 'test:', sessionStorageKey: 'test:session-id',
    sessionAllowedOrigins: [], sessionAccessState: 'active', sessionAccessReason: null,
    lastSessionAccessFailure: null, modeEpoch: 0,
    sessionRenewalBlocked: false, sessionRenewalPending: false, sessionRenewalAttempt: null,
    sessionRenewalResponseTimer: null, sessionRenewalTimer: null, sessionAccessExpiryTimer:null, pendingReviewRenewalRequestId: null,
    sessionRenewalBackoffIndex: 0, sessionRenewalMinimumDelayMs: 1000,
    SESSION_RENEWAL_BACKOFF_MS: [10_000, 30_000, 60_000, 120_000, 300_000],
    lodTileRecoveryPending: true, lodTileRetryAttempt: 1, lodTileRetryTimer: null,
    tilesRenderer: { resetFailedTiles: () => resets.push('tiles') },
    state: { activeMode: 'model', meshSource: 'tiles' }, SHARE_PERMISSIONS: {},
    dom: { lodStatus: { textContent: '' }, cloudStatus: { textContent: '' } },
    crypto: { randomUUID: () => REQUEST }, AbortController,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setDisplayUnits() {}, applyProjectConfig() {}, stopLodAvailabilityRefresh() {},
    measurementWorkspace:{invalidate(_reason,{notify=true}={}){if(measurements.invalidated)return;measurements.invalidations++;measurements.invalidated=true;measurements.records.clear();if(notify)context.measurementAccessLost();},isInvalidated:()=>measurements.invalidated},
    installMeasurementWorkspace(){measurements.installs++;measurements.invalidated=false;},
    viewerProductDownloads:null,
    releaseFailedTileReservations() {},
    pcApi: () => ({ renewAccess: () => resets.push('cloud'), accessUnavailable: () => resets.push('unavailable') }),
    redeemViewerGrant: async () => ({ ...session, expiresAt: new Date(Date.now() + 1_800_000).toISOString() }),
  });
  vm.runInContext(source.slice(source.indexOf('function recoverFailedLodTiles()'), source.indexOf('let sessionRenewalTimer')), context);
  vm.runInContext(source.slice(source.indexOf('function sessionControlWindow()'), source.indexOf('async function bootstrapSession()')), context);
  vm.runInContext(source.slice(source.indexOf('async function handleSessionRenewalMessage'), source.indexOf('if (reviewSessionChannel) reviewSessionChannel.onmessage')), context);
  // Execute the real workspace invalidation callback as well as the actual
  // Viewer controller functions: the old stub hid their reentrancy bug.
  context.measurementFixture=measurements;
  const invalidateSource=workspaceSource.match(/  function invalidate\([\s\S]*?\n  }/)[0];
  const clearDisplaySource=workspaceSource.match(/  function clearDisplayRequests\([\s\S]*?\n  }/)[0];
  vm.runInContext(`measurementWorkspace.invalidate=(()=>{
    let invalidated=false,viewGeneration=0,ready=true,adminAllowed=true,selected='private',lastSvg='';
    let recordSnapshot=['private'],orderedRecords=['private'],lastOverlayFrame={};
    const displayCache=new Map([['private',{state:'pending',controller:{abort(){measurementFixture.displayAborts++;}}}]]);
    const selectedExports=new Set(),svg={innerHTML:'private'},controls={hidden:false};
    const disarm=()=>{},closeDialogs=()=>{},tell=()=>{},onAccessLost=measurementAccessLost;
    const store={invalidate(){measurementFixture.invalidations++;measurementFixture.invalidated=true;measurementFixture.records.clear();}};
    ${clearDisplaySource}
    ${invalidateSource}
    return invalidate;
  })()`,context);
  return { context, timers, posts, resets, measurements };
}

test('parallel tile/cloud authorization failures coalesce and successful renewal resumes both runtimes', async () => {
  const f = fixture();
  assert.equal(f.context.requestSessionRenewal('tile-authorization'), true);
  assert.equal(f.context.requestSessionRenewal('pointcloud-authorization'), false);
  assert.equal(f.posts.length, 1);
  assert.equal(f.context.sessionAccessLabel(), 'LOD: renewing access');
  await f.context.handleSessionRenewalMessage({ version: 1, type: 'ltds-viewer:renew-session',
    requestId: REQUEST, grant: '11111111-2222-4333-8444-555555555555' }, { reviewChannel: true });
  assert.deepEqual(f.resets, ['tiles', 'cloud']);
  assert.equal(f.context.sessionAccessLabel(), null);
  assert.equal(f.context.sessionRenewalPending, false);
  assert.equal(f.context.lodTileRecoveryPending, false);
  assert.equal(f.context.TILES_URL, '/stable/tileset.json');
  assert.equal(f.context.sessionAccessGeneration, 1);
});

test('current-access denial far before expiry is visible without requesting a controller-rejected early grant', () => {
  const f = fixture();
  f.context.activeViewerSession.expiresAt = new Date(Date.now() + 1_800_000).toISOString();
  assert.equal(f.context.requestSessionRenewal('tile-authorization'), false);
  assert.equal(f.posts.length, 0);
  assert.equal(f.context.sessionRenewalPending, false);
  assert.equal(f.context.sessionRenewalBlocked, true);
  assert.match(f.context.sessionAccessLabel(), /reopen this model/);
  assert.equal(f.context.tilesRenderer !== null, true);
});

test('missing controller preserves still-valid personal access and retries transport', () => {
  const f = fixture({ controller: false });
  assert.equal(f.context.requestSessionRenewal('tile-authorization'), false);
  assert.match(f.context.dom.lodStatus.textContent, /retrying access/);
  assert.equal(f.measurements.records.size,1);
  assert.equal(f.context.sessionDiagnostics().reason, 'controller-unavailable');
  assert.equal(f.context.tilesRenderer !== null, true);
  assert.equal(f.context.lodTileRecoveryPending, true);
  assert.equal(f.resets.includes('tiles'), false);
});

test('controller timeout stays visible while a bounded-delay retry is scheduled', () => {
  const f = fixture();
  f.context.requestSessionRenewal();
  [...f.timers.values()].find(timer => timer.delay === 30_000).fn();
  assert.equal(f.context.sessionRenewalPending, false);
  assert.match(f.context.sessionAccessLabel(), /retrying access/);
  assert.equal(f.measurements.records.size,1);
  assert.equal(f.measurements.invalidations,0);
  assert.equal([...f.timers.values()].some(timer => timer.delay === 10_000), true);
  assert.equal(f.context.sessionDiagnostics().reason, 'controller-timeout');
});

test('only the exact controller request may mark authorization unavailable', async () => {
  const f = fixture();
  f.context.requestSessionRenewal();
  const message = { version: 1, type: 'ltds-viewer:session-unavailable', requestId: REQUEST,
    modelId: 'model-one', reason: 'authorization-required' };
  await f.context.handleSessionRenewalMessage({ ...message, requestId: 'other' }, { reviewChannel: true });
  assert.equal(f.context.sessionRenewalPending, true);
  await f.context.handleSessionRenewalMessage(message, { reviewChannel: true });
  assert.equal(f.context.sessionRenewalPending, false);
  assert.equal(f.context.sessionRenewalBlocked, true);
  assert.match(f.context.sessionAccessLabel(), /reopen this model/);
  assert.equal(f.context.requestSessionRenewal(), false);
  assert.deepEqual(f.resets, ['unavailable']);
});

test('normal LOD status cannot overwrite access renewal, and diagnostics omit capabilities', () => {
  assert.match(source, /dom\.lodStatus\.textContent = sessionAccessLabel\(\)\s*\|\|/);
  const f = fixture();
  f.context.requestSessionRenewal();
  const diagnostics = JSON.stringify(f.context.sessionDiagnostics());
  assert.doesNotMatch(diagnostics, /private-token|session-id|model-one|\/stable/);
  assert.match(diagnostics, /renewalPending/);
});

test('proactive renewal clears the cloud access label even without a denied EPT request', async () => {
  const f = fixture();
  f.context.state.activeMode = 'cloud';
  f.context.requestSessionRenewal();
  assert.equal(f.context.dom.cloudStatus.textContent, 'Cloud: renewing access');
  await f.context.handleSessionRenewalMessage({ version: 1, type: 'ltds-viewer:renew-session',
    requestId: REQUEST, grant: '11111111-2222-4333-8444-555555555555' }, { reviewChannel: true });
  assert.equal(f.context.dom.cloudStatus.textContent, 'Cloud: access renewed');
});

test('measurement denial far before expiry cannot start an ignored early renewal',()=>{
  const f=fixture();f.context.activeViewerSession.expiresAt=new Date(Date.now()+1800000).toISOString();
  f.context.measurementWorkspace.invalidate('HTTP 403');
  assert.equal(f.context.sessionRenewalBlocked,true);assert.equal(f.posts.length,0);
  assert.equal(f.context.sessionRenewalPending,false);assert.equal(f.measurements.invalidations,1);
});

test('expired timeout invalidates once without recursive measurement-triggered renewal',()=>{
  const f=fixture();f.context.requestSessionRenewal();
  f.context.activeViewerSession.expiresAt=new Date(Date.now()-1).toISOString();
  [...f.timers.values()].find(t=>t.delay===30000).fn();
  assert.equal(f.context.sessionAccessState,'unavailable');assert.equal(f.measurements.invalidations,1);assert.equal(f.measurements.displayAborts,1);
  assert.equal(f.context.sessionRenewalPending,false);assert.equal(f.context.sessionRenewalAttempt,null);
  assert.equal(f.posts.filter(p=>p.type==='ltds-viewer:session-expiring').length,1);
  assert.equal([...f.timers.values()].filter(t=>t.delay===10000).length,1);
});

test('exact expiry hides personal data but an obsolete expiry timer cannot hide renewed data',async()=>{
  const f=fixture();f.context.scheduleSessionRenewal(f.context.activeViewerSession);
  const expired=f.timers.get(f.context.sessionAccessExpiryTimer).fn;
  f.context.requestSessionRenewal();
  await f.context.handleSessionRenewalMessage({version:1,type:'ltds-viewer:renew-session',requestId:REQUEST,grant:'11111111-2222-4333-8444-555555555555'},{reviewChannel:true});
  expired();assert.equal(f.context.sessionAccessState,'active');assert.equal(f.measurements.records.size,1);
  f.timers.get(f.context.sessionAccessExpiryTimer).fn();
  assert.equal(f.context.sessionAccessState,'unavailable');assert.equal(f.measurements.records.size,0);
  assert.equal(f.context.sessionDiagnostics().reason,'session-expired');
});

test('unavailable access immediately hides personal records and same-person renewal recreates the private workspace',async()=>{
  const f=fixture();f.context.requestSessionRenewal();
  f.context.setSessionAccessState('unavailable','temporary-denial');
  assert.equal(f.measurements.invalidations,1);assert.equal(f.measurements.records.size,0);assert.equal(f.measurements.installs,0);
  await f.context.handleSessionRenewalMessage({version:1,type:'ltds-viewer:renew-session',requestId:REQUEST,grant:'11111111-2222-4333-8444-555555555555'},{reviewChannel:true});
  assert.equal(f.context.sessionAccessState,'active');assert.equal(f.measurements.installs,1);assert.equal(f.measurements.invalidated,false);
  assert.equal(f.measurements.records.size,0,'a fresh private store reloads rather than restoring stale records');
});

test('same-person proactive renewal preserves the existing personal workspace',async()=>{
  const f=fixture();f.context.requestSessionRenewal();
  await f.context.handleSessionRenewalMessage({version:1,type:'ltds-viewer:renew-session',requestId:REQUEST,grant:'11111111-2222-4333-8444-555555555555'},{reviewChannel:true});
  assert.equal(f.measurements.installs,0);assert.equal(f.measurements.invalidations,0);assert.equal(f.measurements.records.get('private'),'geometry');
});

test('renewal changing person, audience or immutable version fails closed before resource recovery',async()=>{
  for(const scope of ['subject','audience','version']){
    const f=fixture(),current=f.context.activeViewerSession;
    f.context.redeemViewerGrant=async()=>({...current,expiresAt:new Date(Date.now()+1_800_000).toISOString(),...(scope==='subject'?{subject:'person-two'}:scope==='audience'?{audience:'client'}:{model:{...current.model,activeVersion:{id:'version-two'}}})});
    f.context.requestSessionRenewal();
    await f.context.handleSessionRenewalMessage({version:1,type:'ltds-viewer:renew-session',requestId:REQUEST,grant:'11111111-2222-4333-8444-555555555555'},{reviewChannel:true});
    assert.equal(f.context.sessionAccessState,'unavailable',scope);assert.equal(f.context.sessionRenewalBlocked,true,scope);
    assert.equal(f.measurements.records.size,0,scope);assert.equal(f.measurements.installs,0,scope);assert.deepEqual(f.resets,['unavailable'],scope);
    assert.equal(f.context.activeViewerSession,current,scope);assert.equal(f.context.sessionAccessGeneration,0,scope);
  }
});

test('returning controller advisory accelerates only a due exact-channel model request and coalesces duplicates',async()=>{
  const f=fixture(),message={version:1,type:'ltds-viewer:controller-ready',channelId:REQUEST,modelId:'model-one'};
  await f.context.handleSessionRenewalMessage(message,{reviewChannel:true});
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].type,'ltds-viewer:session-expiring');
  const attempt=f.context.sessionRenewalAttempt;
  await f.context.handleSessionRenewalMessage(message,{reviewChannel:true});
  assert.equal(f.posts.length,1);assert.equal(f.context.sessionRenewalAttempt,attempt);
  assert.equal(f.context.sessionAccessGeneration,0);assert.deepEqual(f.resets,[],'advisory alone renews no resources');
});

test('controller advisory ignores spoofed shape/channel/model, wrong mode, early and blocked sessions',async()=>{
  for(const scenario of ['shape','channel','model','mode','early','blocked','transport','disposed']){
    const f=fixture({controller:scenario!=='disposed'}),message={version:1,type:'ltds-viewer:controller-ready',channelId:REQUEST,modelId:'model-one'};
    if(scenario==='shape')message.extra=true;if(scenario==='channel')message.channelId='old-controller';if(scenario==='model')message.modelId='other';if(scenario==='mode')f.context.VIEW_MODE='public';if(scenario==='early')f.context.activeViewerSession.expiresAt=new Date(Date.now()+1800000).toISOString();if(scenario==='blocked')f.context.sessionRenewalBlocked=true;
    await f.context.handleSessionRenewalMessage(message,{reviewChannel:scenario!=='transport'});
    assert.equal(f.posts.length,0,scenario);assert.equal(f.context.sessionRenewalPending,false,scenario);assert.deepEqual(f.resets,[],scenario);
    if(scenario==='blocked')assert.equal(f.context.sessionRenewalBlocked,true);
  }
});

function tileFailureListener(f) {
  let listener;
  Object.assign(f.context, {
    rendererInstance: f.context.tilesRenderer,
    classifyTileLoadFailure: () => ({ kind: 'authorization', status: 403 }),
    lodTileLastFailureAt: 0,
    emitLodDebugSnapshot() {},
    console: { error() {} },
  });
  f.context.rendererInstance.addEventListener = (name, callback) => { listener = callback; };
  const start = source.indexOf("  rendererInstance.addEventListener('load-error',");
  const end = source.indexOf('  tilesParent.add(rendererInstance.group);', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), f.context);
  return listener;
}

test('additional denied tiles do not replace a blocked-access warning with fictitious renewal', () => {
  const f = fixture();
  f.context.activeViewerSession.expiresAt = new Date(Date.now() + 1_800_000).toISOString();
  const fail = tileFailureListener(f);
  fail({});
  assert.equal(f.context.sessionRenewalBlocked, true);
  assert.match(f.context.dom.lodStatus.textContent, /access unavailable/);
  fail({});
  assert.match(f.context.dom.lodStatus.textContent, /access unavailable/);
  assert.equal(f.context.sessionRenewalPending, false);
  assert.equal(f.posts.length, 0, 'a current-generation denial cannot bypass authorization');
  const attribution = f.context.sessionDiagnostics().lastFailure;
  assert.equal(attribution.source, 'tile');
  assert.equal(attribution.mode, 'model');
  assert.equal(attribution.status, 403);
  assert.equal(attribution.renewalBlocked, true);
  assert.doesNotMatch(JSON.stringify(attribution), /private-token|session-id|model-one|\/stable/);
});

test('disposed model errors cannot block access after switching modes or replacing the renderer', () => {
  for (const replacement of [null, {}]) {
    const f = fixture();
    const fail = tileFailureListener(f);
    f.context.tilesRenderer = replacement;
    f.context.state.activeMode = replacement ? 'model' : 'cloud';
    fail({});
    assert.equal(f.context.sessionAccessState, 'active');
    assert.equal(f.posts.length, 0);
  }
});
