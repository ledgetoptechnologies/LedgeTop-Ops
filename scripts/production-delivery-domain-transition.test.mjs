import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { PROFILE, canonical, hash, validateInstallation, varsOf, parseDeploymentArguments } from './production-deploy.mjs';
import { domainPhaseValues, domainRecognitionProfile, domainRecognitionDiff } from './production-domain-recognition.mjs';
import { compileDeliveryDomainTransition, compileDeliveryPublicLinkTransition, compileOperationsCanonicalTransition } from './production-delivery-domain-transition.mjs';
import { NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE, NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE, nativeDeliveryDeploymentEnabled } from '../apps/client/src/worker/operations-native-delivery-deployment.ts';

const FROM='portal-entry-canonical', TO='delivery-public-canonical';
const profileChanged=['LEGACY_CLIENT_ORIGINS','CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE'].sort();
const historicalTransitionChanged=['EXPECTED_HOST','PUBLIC_BASE_URL','PUBLIC_SHARE_ORIGIN',...profileChanged].sort();
function fixture() {
  const base=structuredClone(PROFILE), snapshot={}; let n=0;
  // The synthetic pre-cutover installation predates the canonical Operations
  // admin host; bind this fixture to the historical fallback, not v4 state.
  delete base.onboardingAdminOrigin;
  for(const [app,spec] of Object.entries(base.workers)) {
    const defaults=JSON.parse(fs.readFileSync(new URL(`../apps/${app}/wrangler.jsonc`,import.meta.url))).vars;
    const vars=Object.fromEntries(spec.plainNames.map(name=>[name,defaults[name]??'synthetic-fixture']));
    if(app==='operations') Object.assign(vars,{PUBLIC_BASE_URL:'https://ops.ledgetopdroneservices.com',
      EXPECTED_HOST:'ops.ledgetopdroneservices.com',PUBLIC_SHARE_ORIGIN:'https://portal.ledgetopdroneservices.com',
      DELIVERY_BASE_URL:'https://portal.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_ADMIN_ENABLED:'true',CLIENT_ONBOARDING_ADMIN_ORIGIN:'https://ops.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED:'true',CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED:'true',
      CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS:'["synthetic-owner"]',CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE:'2026-10-20T00:00:00.000Z',
      PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED:'true'});
    // This fixture models the historical pre-cutover installation, independently
    // of the checked-in defaults for new deployments.
    if(app==='client') Object.assign(vars, {
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED:'true',
      PUBLIC_BASE_URL:'https://portal.ledgetopdroneservices.com',
      PUBLIC_SHARE_ORIGIN:'https://portal.ledgetopdroneservices.com',
      EXPECTED_HOST:'portal.ledgetopdroneservices.com',
      LEGACY_CLIENT_ORIGINS:'https://client.ledgetopdroneservices.com',
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE:NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE,
    });
    for(const name of Object.keys(spec.plainValueSHA256)) spec.plainValueSHA256[name]=hash(vars[name]);
    const bindings=[...structuredClone(spec.bindings),...Object.entries(vars).map(([name,text])=>({name,type:'plain_text',text}))];
    const id=`${String(++n).repeat(8)}-1111-4111-8111-111111111111`;
    const resources={script:{...structuredClone(spec.script),etag:'a'.repeat(64),last_deployed_from:'wrangler'},script_runtime:structuredClone(spec.runtime),bindings};
    snapshot[app]={latest:id,deployment:{id,versions:[{version_id:id,percentage:100}],strategy:'percentage'},version:{id,resources},
      settings:{...structuredClone(spec.settings),annotations:{'workers/message':'synthetic'},bindings:structuredClone(bindings)},
      modern:{id,...app==='ops-sync'?{}:{assets:{opaque:`synthetic-${app}`}},modules:[{name:'index.js',content_base64:Buffer.from('synthetic').toString('base64')}]},
      schedules:{schedules:spec.crons.map(cron=>({cron,created_on:'synthetic-timestamp'}))}};
    spec.assetsSHA256=hash(canonical(snapshot[app].modern.assets??null));
  }
  for(const [app,vars] of Object.entries(domainPhaseValues(FROM)))
    for(const [name,text] of Object.entries(vars)) for(const bindings of [snapshot[app].version.resources.bindings,snapshot[app].settings.bindings]) bindings.find(row=>row.name===name).text=text;
  validateInstallation(snapshot,{profile:domainRecognitionProfile(FROM,base)});
  return {base,snapshot};
}
function patch(snapshot,app,name,text) {
  for(const bindings of [snapshot[app].version.resources.bindings,snapshot[app].settings.bindings]) bindings.find(row=>row.name===name).text=text;
}

test('delivery recognition changes only the remaining Client delivery scalars from canonical portal entry',()=>{
  const before=domainRecognitionProfile(FROM), after=domainRecognitionProfile(TO);
  assert.deepEqual(after.workers.operations,before.workers.operations);
  assert.deepEqual(after.workers['ops-sync'],before.workers['ops-sync']);
  const hashes=before.workers.client.plainValueSHA256;
  assert.deepEqual(Object.keys(hashes).filter(name=>hashes[name]!==after.workers.client.plainValueSHA256[name]).sort(),profileChanged);
  assert.equal(domainPhaseValues(TO).client.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE,NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE);
  assert.equal(domainPhaseValues(TO).client.CLIENT_PORTAL_ORIGIN,'https://portal.ledgetop.app');
  assert.equal(domainPhaseValues(TO).client.CLIENT_PORTAL_ORIGINS,domainPhaseValues(FROM).client.CLIENT_PORTAL_ORIGINS);
  const left=structuredClone(before),right=structuredClone(after);delete left.workers.client.plainValueSHA256;delete right.workers.client.plainValueSHA256;
  assert.deepEqual(left,right);
  assert.equal(domainRecognitionDiff(TO).writesPerformed,false);
  assert.equal(domainRecognitionDiff(TO).deploymentEnabled,false);
});

test('offline transition produces a complete settings draft and mutates no input or non-Client state',()=>{
  const {base,snapshot}=fixture(), original=structuredClone(snapshot);
  const plan=compileDeliveryDomainTransition(snapshot,base);
  assert.deepEqual(snapshot,original);
  assert.equal(plan.writesPerformed,false);assert.equal(plan.activationEnabled,false);assert.equal(plan.redirectEnabled,false);
  assert.deepEqual(Object.keys(plan.changes).sort(),historicalTransitionChanged);
  assert.deepEqual(plan.expected.operations,snapshot.operations);assert.deepEqual(plan.expected['ops-sync'],snapshot['ops-sync']);
  assert.deepEqual(plan.expected.client.modern,snapshot.client.modern);
  assert.deepEqual(plan.expected.client.version.resources.script,snapshot.client.version.resources.script);
  assert.deepEqual(plan.expected.client.schedules,snapshot.client.schedules);
  assert.deepEqual(plan.settingsDraft,plan.expected.client.settings);
  assert.deepEqual(plan.settingsDraft.bindings.filter(row=>!historicalTransitionChanged.includes(row.name)),snapshot.client.settings.bindings.filter(row=>!historicalTransitionChanged.includes(row.name)));
  assert.equal(validateInstallation(plan.expected,{profile:plan.afterProfile}),plan.expected);
  assert.equal(nativeDeliveryDeploymentEnabled(varsOf(plan.expected.client)),true);
  assert.throws(()=>validateInstallation(plan.expected,{profile:plan.beforeProfile}),/scalar configuration changed/);
  assert.throws(()=>compileDeliveryDomainTransition(plan.expected,base),/scalar configuration changed/);
});

test('reject partial tuple, unrelated scalar/Viewer drift, resource changes and settings drift before producing a plan',()=>{
  for(const [app,name,value] of [['client','PUBLIC_SHARE_ORIGIN','https://delivery.ledgetop.app'],
    ['client','LEGACY_CLIENT_ORIGINS',''],['client','CLIENT_PORTAL_ORIGINS','https://portal.ledgetop.app'],
    ['operations','VIEWER_BASE_URL','https://unreviewed.invalid'],['operations','PUBLIC_SHARE_ORIGIN','https://delivery.ledgetop.app']]) {
    const {base,snapshot}=fixture();patch(snapshot,app,name,value);
    assert.throws(()=>compileDeliveryDomainTransition(snapshot,base),/scalar configuration changed/);
  }
  const resource=fixture();resource.snapshot.client.version.resources.bindings.find(row=>row.type==='d1').id='wrong';
  assert.throws(()=>compileDeliveryDomainTransition(resource.snapshot,resource.base),/bindings differ|resource/);
  const assets=fixture();assets.snapshot.client.modern.assets.opaque='wrong';
  assert.throws(()=>compileDeliveryDomainTransition(assets.snapshot,assets.base),/asset association/);
  const missing=fixture();missing.snapshot.client.settings.bindings=missing.snapshot.client.settings.bindings.filter(row=>row.name!=='LEGACY_CLIENT_ORIGINS');
  assert.throws(()=>compileDeliveryDomainTransition(missing.snapshot,missing.base),/bindings differ/);
});

test('finite inspect/deploy argument parsing recognizes the phase without arbitrary overrides',()=>{
  assert.deepEqual(parseDeploymentArguments(['--inspect','--domain-phase',TO]),{kind:'inspect',phase:TO});
  assert.equal(parseDeploymentArguments(['--worker','client','--mode','backend','--execute','--domain-phase',TO]).phase,TO);
  assert.throws(()=>parseDeploymentArguments(['--inspect','--domain-phase','delivery-arbitrary']),/Unknown reviewed domain phase/);
});

test('public link generation is a distinct next-step draft preserving private/internal URLs and Client state',()=>{
  const {base,snapshot}=fixture();
  assert.throws(()=>compileDeliveryPublicLinkTransition(snapshot,base),/scalar configuration changed/);
  const clientPlan=compileDeliveryDomainTransition(snapshot,base);
  const linkPlan=compileDeliveryPublicLinkTransition(clientPlan.expected,base);
  assert.deepEqual(linkPlan.changes,{PUBLIC_SHARE_ORIGIN:'https://delivery.ledgetop.app'});
  assert.equal(linkPlan.clientPublicAcceptanceRequiredBeforeApply,true);
  assert.equal(linkPlan.writesPerformed,false); assert.equal(linkPlan.activationEnabled,false); assert.equal(linkPlan.redirectEnabled,false);
  assert.deepEqual(linkPlan.expected.client,clientPlan.expected.client);
  assert.deepEqual(linkPlan.expected['ops-sync'],clientPlan.expected['ops-sync']);
  const oldVars=varsOf(clientPlan.expected.operations),newVars=varsOf(linkPlan.expected.operations);
  assert.deepEqual(Object.keys(newVars).filter(name=>newVars[name]!==oldVars[name]),['PUBLIC_SHARE_ORIGIN']);
  assert.equal(newVars.DELIVERY_BASE_URL,'https://portal.ledgetop.app');
  for(const name of ['INCOMING_BASE_URL','INCOMING_EXPECTED_HOST','VIEWER_BASE_URL','NATIVE_INTEGRATION_CONTROL_ORIGIN'])
    assert.equal(newVars[name],oldVars[name]);
  assert.deepEqual(parseDeploymentArguments(['--inspect','--domain-phase','delivery-links-canonical']),{kind:'inspect',phase:'delivery-links-canonical'});
  assert.throws(()=>compileDeliveryPublicLinkTransition(linkPlan.expected,base),/scalar configuration changed/);
});

test('final staff canonical phase keeps generated public links on delivery.app and changes only existing Ops origin scalars',()=>{
  const {base,snapshot}=fixture();
  const clientPlan=compileDeliveryDomainTransition(snapshot,base);
  const linkPlan=compileDeliveryPublicLinkTransition(clientPlan.expected,base);
  const plan=compileOperationsCanonicalTransition(linkPlan.expected,base);
  assert.equal(plan.beforeProfile.workers.operations.plainNames.length,plan.afterProfile.workers.operations.plainNames.length);
  assert.deepEqual(plan.changes,{PUBLIC_BASE_URL:'https://ops.ledgetop.app',EXPECTED_HOST:'ops.ledgetop.app',
    CLIENT_ONBOARDING_ADMIN_ORIGIN:'https://ops.ledgetop.app'});
  assert.equal(domainPhaseValues('staff-canonical').operations.PUBLIC_SHARE_ORIGIN,'https://delivery.ledgetop.app');
  assert.equal(plan.publicShareOriginPreserved,'https://delivery.ledgetop.app');
  assert.equal(plan.operationsCanonicalWorkerCandidateRequiredBeforeApply,true);
  assert.equal(plan.callbackPreservationWorkerMustPrecedeScalarTransition,true);
  assert.equal(plan.preCallbackPreservationStatesMustExpireOrSettle,true);
  assert.equal(plan.providerMustAllowCanonicalCallbackUriBeforeTransition,true);
  assert.equal(plan.liveAcceptanceStillRequired,true);
  assert.deepEqual(plan.expected.client,linkPlan.expected.client);
  assert.deepEqual(plan.expected['ops-sync'],linkPlan.expected['ops-sync']);
  assert.deepEqual(plan.settingsDraft,plan.expected.operations.settings);
  for(const name of ['DELIVERY_BASE_URL','OPERATIONS_ORIGINS','CLIENT_PORTAL_ORIGINS','INCOMING_BASE_URL',
    'VIEWER_BASE_URL','VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED'])
    assert.equal(varsOf(plan.expected.operations)[name],varsOf(linkPlan.expected.operations)[name],name);
  assert.equal(validateInstallation(plan.expected,{profile:plan.afterProfile}),plan.expected);
  assert.throws(()=>compileOperationsCanonicalTransition(plan.expected,base),/scalar configuration changed/);
});
