import assert from 'node:assert/strict';
import test from 'node:test';
import { staffNavigationTargets, renderStaffNavigation, hasUnfinishedMeasurements } from '../viewer-staff-navigation.mjs';
import { createMeasurementStore } from '../measurement-store.mjs';

const context = { viewMode: 'session', topLevel: true };
const staff = { audience: 'ops', operationsOrigin: 'https://ops.example.test' };

test('staff navigation uses only fixed same-tab application destinations', () => {
  assert.deepEqual(staffNavigationTargets(staff, context), {
    dashboard: 'https://ops.example.test/', models: 'https://ops.example.test/viewer',
  });
  // URL/referrer/hash-derived destinations have no input in this contract.
  assert.deepEqual(staffNavigationTargets({ ...staff, returnUrl: 'https://attacker.test/', referrer: 'https://attacker.test/' }, context),
    staffNavigationTargets(staff, context));
  assert.deepEqual(staffNavigationTargets({ ...staff, operationsOrigin: 'http://127.0.0.1:8091' }, context), {
    dashboard: 'http://127.0.0.1:8091/', models: 'http://127.0.0.1:8091/viewer',
  });
});

test('public, client, embedded and older server sessions never acquire staff navigation', () => {
  for (const viewMode of ['view', 'project', 'embed', 'admin', undefined])
    assert.equal(staffNavigationTargets(staff, { ...context, viewMode }), null);
  assert.equal(staffNavigationTargets(staff, { ...context, topLevel: false }), null);
  assert.equal(staffNavigationTargets({ ...staff, audience: 'client' }, context), null);
  assert.equal(staffNavigationTargets({ audience: 'ops' }, context), null);
  assert.equal(staffNavigationTargets(null, context), null);
});

test('malformed origins cannot introduce a destination, credential, query or fragment', () => {
  for (const operationsOrigin of [undefined, null, '', 12, 'javascript:alert(1)', '//ops.example.test',
    'http://ops.example.test', 'ftp://localhost', 'https://user:pass@ops.example.test',
    'https://ops.example.test/', 'https://ops.example.test/viewer',
    'https://ops.example.test?returnUrl=https://attacker.test', 'https://ops.example.test#dashboard',
    'https://ops.example.test\\@attacker.test/', 'https://ops.example.test\n'])
    assert.equal(staffNavigationTargets({ ...staff, operationsOrigin }, context), null, String(operationsOrigin));
});

test('rendering hides and clears stale staff destinations when the current session is ineligible', () => {
  const anchor = () => ({ href: undefined, removeAttribute(name) { assert.equal(name, 'href'); delete this.href; } });
  const nodes = { container: { hidden: true }, dashboard: anchor(), models: anchor() };
  assert.equal(renderStaffNavigation(nodes, staff, context), true);
  assert.equal(nodes.container.hidden, false);
  assert.equal(nodes.dashboard.href, 'https://ops.example.test/');
  assert.equal(nodes.models.href, 'https://ops.example.test/viewer');
  assert.equal(renderStaffNavigation(nodes, { audience: 'client' }, context), false);
  assert.equal(nodes.container.hidden, true);
  assert.equal(nodes.dashboard.href, undefined);
  assert.equal(nodes.models.href, undefined);
  assert.equal(renderStaffNavigation({ container: null }, staff, context), false);
});

test('breadcrumb and logo use the same server-origin gate and restore plain branding for other audiences', () => {
  const node = () => ({ hidden: false, attrs: {}, setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this.attrs[k]; if(k==='href')delete this.href; } });
  const nodes = { container: node(), company: node(), dashboard: node(), models: node(), logo: node() };
  assert.equal(renderStaffNavigation(nodes, staff, context), true);
  assert.equal(nodes.logo.href, nodes.dashboard.href);
  assert.equal(nodes.logo.attrs['aria-label'], 'Dashboard');
  assert.equal(nodes.company.hidden, true);
  for (const session of [{...staff,audience:'client'},{...staff,operationsOrigin:'https://ops.example.test/bad'},null]) {
    renderStaffNavigation(nodes, session, context);
    assert.equal(nodes.container.hidden, true);
    assert.equal(nodes.company.hidden, false);
    assert.equal(nodes.logo.href, undefined);
    assert.equal(nodes.logo.attrs['aria-label'], undefined);
    renderStaffNavigation(nodes, staff, context);
  }
});

test('unfinished predicate includes drawing, editing snapshots and memory-only renewal recovery', () => {
  assert.equal(hasUnfinishedMeasurements(null, null), false);
  assert.equal(hasUnfinishedMeasurements({isDrawing:()=>true}), true);
  assert.equal(hasUnfinishedMeasurements({isDrawing:()=>false},{hasPending:()=>true}), true);
  const workspace = {isDrawing:()=>false,store:{statuses:new Map([['a','Saved'],['b','Temporary — resets on refresh']])}};
  assert.equal(hasUnfinishedMeasurements(workspace), false, 'saved viewing does not prompt');
  workspace.store.statuses.set('a','Not saved: offline');
  assert.equal(hasUnfinishedMeasurements(workspace), true);
});

test('real store pending save remains guarded after a draft disarms; settlement clears it, failure keeps it', async () => {
  let settle;
  const store = createMeasurementStore({token:()=> 'test-only-credential',fetcher:()=>new Promise(resolve=>{settle=resolve;})});
  const workspace={isDrawing:()=>false,store};
  const record={id:'nav-test',collection:'map',kind:'distance',vertices:[[0,0,0],[1,0,0]],coordinateReference:{crs:'EPSG:32616'}};
  const saving=store.save(record);
  assert.equal(hasUnfinishedMeasurements(workspace), true);
  await Promise.resolve();
  settle({ok:true,status:200,json:async()=>({measurement:{...record,revision:1}})});
  await saving;
  assert.equal(hasUnfinishedMeasurements(workspace), false);
  const failed=store.save({...record,revision:1});
  await Promise.resolve();
  settle({ok:false,status:503,json:async()=>({error:'test service unavailable'})});
  await assert.rejects(failed,/test service unavailable/);
  assert.equal(hasUnfinishedMeasurements(workspace), true);
});
