import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROFILE, canonical, hash } from './production-deploy.mjs';
import { domainPhaseValues } from './production-domain-recognition.mjs';
import { compileOrdinaryFrontendReleasePlan, verifyOrdinaryFrontendArtifacts, validateOrdinaryFrontendReleasePlan } from './ordinary-frontend-release-plan.mjs';
const clone = value => structuredClone(value);
function fixture() {
  const profile = clone(PROFILE), snapshot = {}, phase = domainPhaseValues('portal-entry-canonical');
  let index = 1;
  for (const [app, spec] of Object.entries(profile.workers)) {
    const defaults = JSON.parse(fs.readFileSync(new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url))).vars;
    const vars = Object.fromEntries(spec.plainNames.map(name => [name, defaults[name] ?? 'synthetic-fixture']));
    if (app === 'operations') Object.assign(vars, {
      CLIENT_ONBOARDING_ADMIN_ENABLED: 'true', CLIENT_ONBOARDING_ADMIN_ORIGIN: 'https://ops.ledgetopdroneservices.com',
      PUBLIC_BASE_URL: 'https://ops.ledgetopdroneservices.com', EXPECTED_HOST: 'ops.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: 'true', CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED: 'true',
      CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS: '["synthetic-owner"]', CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE: '2026-10-20T00:00:00.000Z',
      PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: 'true',
    });
    if (app === 'client') vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = 'true';
    Object.assign(vars, phase[app]);
    for (const name of spec.plainNames) spec.plainValueSHA256[name] = hash(vars[name]);
    const bindings = [...clone(spec.bindings), ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text }))];
    const digit = String(index++), id = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
    const resources = { script: clone(spec.script), script_runtime: clone(spec.runtime), bindings };
    snapshot[app] = { latest: id, version: { id, resources },
      deployment: { versions: [{ version_id: id, percentage: 100 }] },
      settings: { ...clone(spec.settings), bindings: clone(bindings) },
      modern: { id, assets: app === 'ops-sync' ? undefined : { config: { base_path: '/',
        html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application',
        run_worker_first: clone(spec.metadata.assets.config.run_worker_first) } } },
      schedules: { schedules: spec.crons.map(cron => ({ cron })) } };
    spec.assetsSHA256 = hash(canonical(snapshot[app].modern.assets ?? null));
  }
  return { snapshot, options: { profile, mains: { operations: '/reviewed/ops.mjs', client: '/reviewed/client.mjs' } } };
}

function artifacts(t, app='operations') {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ordinary-frontend-plan-'));
 t.after(()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(directory).startsWith('ordinary-frontend-plan-'));fs.rmSync(directory,{recursive:true,force:true});});
 const assets=path.join(directory,'client');fs.mkdirSync(path.join(assets,'assets'),{recursive:true});
 const files={'index.html':'<link rel="icon" href="/favicon.svg"><script type="module" src="/assets/index-reviewed.js"></script>','assets/index-reviewed.js':'export const ui="reviewed";','favicon.svg':'<svg/>','apple-touch-icon.png':'synthetic-icon'};
 for(const [name,body]of Object.entries(files))fs.writeFileSync(path.join(assets,name),body);
 fs.writeFileSync(path.join(assets,'.assetsignore'),'wrangler.json\n.dev.vars\n');
 const main=path.join(directory,'index.js'),map=main+'.map';fs.writeFileSync(main,'export default {fetch(){return new Response("reviewed")}};');fs.writeFileSync(map,JSON.stringify({version:3,sources:['reviewed.ts'],sourcesContent:['reviewed source'],names:[],mappings:''}));
 const pin=file=>({path:file,size:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))});
 const release={schemaVersion:1,application:app,sourceCommit:'8e8554667c7de62cf3be44b5a650697c10f7c9bf',frontendSHA256:'3e745973ad87e592304188819ec0f4fbc692697bb6350c636b94f7d21d7f33c9',main:pin(main),sourceMap:pin(map),assets:{directory:assets,files:Object.keys(files).map(name=>({path:'/'+name,size:Buffer.byteLength(files[name]),sha256:hash(files[name])}))}};
 return{release,assets,repin(name,text){fs.writeFileSync(path.join(assets,name),text);Object.assign(release.assets.files.find(f=>f.path==='/'+name),{size:Buffer.byteLength(text),sha256:hash(text)});}};
}
for(const app of ['operations','client'])test(app+' native full frontend config preserves complete controls and every scalar/secret',t=>{
 const {snapshot,options}=fixture(),{release}=artifacts(t,app),input=clone(snapshot),profile=clone(options.profile);
 const plan=compileOrdinaryFrontendReleasePlan(snapshot,{app,release,profile:options.profile}),c=plan.config;
 assert.deepEqual(snapshot,input);assert.deepEqual(options.profile,profile);assert.equal(c.keep_vars,false);assert.deepEqual(c.vars,{});assert.deepEqual(c.unsafe.metadata.keep_bindings,[]);assert.equal(Object.hasOwn(c.unsafe.metadata,'assets'),false);assert.equal(Object.hasOwn(c.unsafe.metadata,'keep_assets'),false);
 assert.deepEqual(c.unsafe.bindings,snapshot[app].version.resources.bindings.filter(r=>r.name!=='ASSETS').map(r=>({name:r.name,type:'inherit'})));
 assert.equal(c.assets.binding,'ASSETS');assert.equal(c.assets.directory,release.assets.directory);assert.deepEqual(c.assets.run_worker_first,snapshot[app].modern.assets.config.run_worker_first);assert.deepEqual(c.triggers.crons,options.profile.workers[app].crons);
 assert.equal(c.unsafe.bindings.some(r=>r.name==='UI_ACTIVE_RELEASE'||r.name==='UI_RELEASE_ASSETS'),false);assert.equal(c.unsafe.bindings.filter(r=>r.name==='CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE').length,1);
 assert.deepEqual(plan.expectedBindings,snapshot[app].version.resources.bindings);assert.deepEqual(plan.expectedAssetsConfiguration,snapshot[app].modern.assets);assert.equal(plan.expectedProfile.frontendSHA256,release.frontendSHA256);assert.equal(plan.beforeProfile.frontendSHA256,options.profile.frontendSHA256);
 assert.deepEqual(plan.expectedProfile.workers,plan.beforeProfile.workers);assert.equal(plan.browserProof.files.length,4);assert.ok(plan.browserProof.files.some(f=>f.path==='/apple-touch-icon.png'));assert.equal(plan.deploymentEnabled,false);assert.equal(plan.historicalOrphanAssetsRetained,false);assert.ok(Object.isFrozen(c.assets));
 if(app==='operations')assert.equal(snapshot[app].version.resources.bindings.filter(r=>['plain_text','json','secret_text','secret_key'].includes(r.type)).length,128);
 assert.equal(validateOrdinaryFrontendReleasePlan(snapshot,plan,{app,release,profile:options.profile}),plan);
});
test('complete tree rejects unlisted, absent and mutated bytes',t=>{const {release,assets}=artifacts(t);fs.writeFileSync(path.join(assets,'surprise.txt'),'unreviewed');assert.throws(()=>verifyOrdinaryFrontendArtifacts(release),/unreviewed file/);fs.unlinkSync(path.join(assets,'surprise.txt'));fs.unlinkSync(path.join(assets,'favicon.svg'));assert.throws(()=>verifyOrdinaryFrontendArtifacts(release),/inventory/);fs.writeFileSync(path.join(assets,'favicon.svg'),'changed');assert.throws(()=>verifyOrdinaryFrontendArtifacts(release),/differs/);});
test('root index rejects prefixed build even when inventory matches those bytes',t=>{const a=artifacts(t);a.repin('index.html','<script src="/_ui/operations/release/assets/index.js"></script>');assert.throws(()=>verifyOrdinaryFrontendArtifacts(a.release),/root-base/);});
test('root HTML missing local icon is rejected, not silently omitted',t=>{const a=artifacts(t);a.repin('index.html','<link href="/missing-icon.png"><script src="/assets/index-reviewed.js"></script>');assert.throws(()=>verifyOrdinaryFrontendArtifacts(a.release),/absent/);});
test('inventory rejects case collisions and traversal',t=>{const {release}=artifacts(t);release.assets.files.push({...release.assets.files[2],path:'/Favicon.svg'});assert.throws(()=>verifyOrdinaryFrontendArtifacts(release),/case-colliding/);release.assets.files.pop();release.assets.files[2].path='/../favicon.svg';assert.throws(()=>verifyOrdinaryFrontendArtifacts(release),/Noncanonical/);});
test('unexpected ignore rules cannot hide files',t=>{const {release,assets}=artifacts(t);fs.writeFileSync(path.join(assets,'.assetsignore'),'assets/**\n');assert.throws(()=>verifyOrdinaryFrontendArtifacts(release),/ignore policy/);});
test('native artifact drift invalidates recompilation',t=>{const {snapshot,options}=fixture(),{release}=artifacts(t);const args={app:'operations',release,profile:options.profile},plan=compileOrdinaryFrontendReleasePlan(snapshot,args);fs.appendFileSync(release.main.path,'changed');assert.throws(()=>validateOrdinaryFrontendReleasePlan(snapshot,plan,args),/Native artifact differs/);});
test('installed scalar drift cannot be carried through as a new release',t=>{const {snapshot,options}=fixture(),{release}=artifacts(t);for(const rows of[snapshot.operations.version.resources.bindings,snapshot.operations.settings.bindings])rows.find(r=>r.name==='PUBLIC_BASE_URL').text='https://unreviewed.invalid';assert.throws(()=>compileOrdinaryFrontendReleasePlan(snapshot,{app:'operations',release,profile:options.profile}),/scalar configuration changed/);});
test('planner rejects an unsupported asset config rather than override native JWT metadata',t=>{const {snapshot,options}=fixture(),{release}=artifacts(t);snapshot.operations.modern.assets.config.unreviewed=true;options.profile.workers.operations.assetsSHA256=hash(canonical(snapshot.operations.modern.assets));assert.throws(()=>compileOrdinaryFrontendReleasePlan(snapshot,{app:'operations',release,profile:options.profile}),/Unsupported installed asset/);});

test('arbitrary pinned source map cannot replace the map native upload actually reads',t=>{const {release}=artifacts(t);const alternate=path.join(path.dirname(release.main.path),'alternate.js.map');fs.copyFileSync(release.sourceMap.path,alternate);release.sourceMap.path=alternate;assert.throws(()=>verifyOrdinaryFrontendArtifacts(release),/main sibling path/);});
test('hard-linked release bytes are rejected consistently',t=>{const {release,assets}=artifacts(t);const link=path.join(path.dirname(assets),'linked-favicon.svg');fs.linkSync(path.join(assets,'favicon.svg'),link);assert.throws(()=>verifyOrdinaryFrontendArtifacts(release),/single-link regular file/);});
