import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { canonicalDeliveryEntryRedirect } from '../apps/client/src/worker/canonical-delivery-routing.ts';
import { configuredPublicRequestOrigins, requestHostAllowed, clientPortalRequestOriginAllowed } from '../apps/client/src/worker/origin-policy.ts';
import { NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE, NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE,
  nativeDeliveryDeploymentEnabled, nativeDeliveryRequestOriginAllowed } from '../apps/client/src/worker/operations-native-delivery-deployment.ts';

const NEW='https://delivery.ledgetop.app', PORTAL='https://portal.ledgetop.app';
const OLD='https://portal.ledgetopdroneservices.com', CLIENT='https://client.ledgetopdroneservices.com';
const LTT_PORTAL='https://portal.ledgetoptechnologies.com';
const env={ENVIRONMENT:'production',EXPECTED_HOST:'delivery.ledgetop.app',PUBLIC_BASE_URL:NEW,PUBLIC_SHARE_ORIGIN:NEW,
  CLIENT_PORTAL_ORIGIN:PORTAL,CLIENT_PORTAL_ORIGINS:`${PORTAL},${OLD}`,
  LEGACY_CLIENT_ORIGINS:`${OLD},${CLIENT}`,CLIENT_PORTAL_RETIRED_ORIGINS:'https://portal.ledgetoptechnologies.com',
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE:NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE};
const navigation={'Sec-Fetch-Dest':'document','Sec-Fetch-Mode':'navigate'};
const redirect=(url,init={},configuration=env,enabled=true)=>canonicalDeliveryEntryRedirect(new Request(url,{headers:navigation,...init}),configuration,enabled);

test('checked-in production config preserves the canonical delivery tuple and historical public links',()=>{
  const config=JSON.parse(readFileSync(new URL('../apps/client/wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(nativeDeliveryDeploymentEnabled(config.vars),true);
  assert.deepEqual(configuredPublicRequestOrigins(config.vars),[NEW,OLD,CLIENT]);
  for(const origin of [NEW,OLD,CLIENT])
    assert.equal(requestHostAllowed(`${origin}/s/synthetic-id`,config.vars),true);
  assert.equal(requestHostAllowed('https://ops.ledgetop.app/s/synthetic-id',config.vars),false);
  assert.deepEqual(config.routes.map(row=>row.pattern).sort(),[
    'delivery.ledgetop.app','portal.ledgetop.app','client.ledgetopdroneservices.com',
    'portal.ledgetopdroneservices.com','portal.ledgetoptechnologies.com',
  ].sort());
});

test('split delivery origin preserves historical public hosts and restricts private native downloads to the canonical portal',()=>{
  assert.deepEqual(configuredPublicRequestOrigins(env),[NEW,OLD,CLIENT]);
  for(const origin of [NEW,OLD,CLIENT]) for(const path of ['/s/synthetic-id','/client-share/synthetic-id','/api/public/shares/synthetic-id/session','/api/public/shares/synthetic-id/items/item/download'])
    assert.equal(requestHostAllowed(`${origin}${path}`,env),true);
  for(const origin of [PORTAL,'https://portal.ledgetoptechnologies.com','https://ops.ledgetop.app','https://ledgetop.app'])
    assert.equal(requestHostAllowed(`${origin}/s/synthetic-id`,env),false);
  for(const origin of [PORTAL,OLD]) {
    assert.equal(requestHostAllowed(`${origin}/api/client/me`,env),true);
    assert.equal(nativeDeliveryRequestOriginAllowed(env,`${origin}/api/client/operations/data/files/item/preview`),origin===PORTAL);
    assert.equal(clientPortalRequestOriginAllowed(new Request(`${origin}/api/client/me`,{headers:{Origin:origin}}),env),true);
  }
  assert.equal(nativeDeliveryRequestOriginAllowed(env,`${NEW}/api/client/me`),false);
  assert.equal(requestHostAllowed(`${NEW}/api/client/me`,env),false);
  assert.equal(requestHostAllowed(`${OLD}/api/internal/project-alpha/portal-v2`,env),false);
  assert.equal(requestHostAllowed(`${PORTAL}/api/internal/project-alpha/portal-v2`,env),true);
});

test('new physical profile accepts only the complete finite public tuple',()=>{
  for(const surface of ['portal','rpc','publication']) assert.equal(nativeDeliveryDeploymentEnabled(env,surface),true);
  for(const patch of [{EXPECTED_HOST:'portal.ledgetopdroneservices.com'},{PUBLIC_BASE_URL:OLD},{PUBLIC_SHARE_ORIGIN:OLD},
    {CLIENT_PORTAL_ORIGIN:OLD},{CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE:NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE},
    {CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE:JSON.stringify({...JSON.parse(NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE),databaseId:'wrong'})}])
    assert.equal(nativeDeliveryDeploymentEnabled({...env,...patch}),false,JSON.stringify(patch));
  assert.equal(requestHostAllowed(`${NEW}/s/id`,{...env,PUBLIC_BASE_URL:OLD}),false);
  assert.equal(requestHostAllowed(`${PORTAL}/s/id`,{...env,LEGACY_CLIENT_ORIGINS:`${OLD},${PORTAL}`}),false);
  assert.equal(requestHostAllowed(`${NEW}/s/id`,{...env,CLIENT_PORTAL_ORIGINS:`${PORTAL},${OLD},${CLIENT}`}),false);
});

test('old deployment profile and staging behavior retain their existing contracts',()=>{
  const old={...env,EXPECTED_HOST:'portal.ledgetopdroneservices.com',PUBLIC_BASE_URL:OLD,PUBLIC_SHARE_ORIGIN:OLD,
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE:NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE};
  assert.equal(nativeDeliveryDeploymentEnabled(old),true);
  assert.equal(nativeDeliveryDeploymentEnabled({...old,ENVIRONMENT:'staging'}),false);
  assert.equal(nativeDeliveryDeploymentEnabled({ENVIRONMENT:'staging',CLIENT_PORTAL_ORIGIN:'https://portal-staging.ledgetopdroneservices.com'}),true);
});

test('fresh legacy browser entry preserves exact path/query; response never consumes the fragment',()=>{
  for(const origin of [OLD,CLIENT,LTT_PORTAL]) for(const root of ['s','client-share']) for(const method of ['GET','HEAD']) {
    const path=`/${root}/synthetic-id?folder=opaque%2Fref&view=list&sort=name&sort=date`;
    const response=redirect(`${origin}${path}`,{method});
    assert.equal(response.status,302);
    assert.equal(response.headers.get('Location'),`${NEW}${path}`);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
    assert.equal(response.headers.has('Set-Cookie'),false);
    assert.equal(response.body,null);
  }
});

test('redirect is opt-in and refuses sessions, media, ranges, POST, API and non-navigation requests',()=>{
  const entry=`${OLD}/s/synthetic-id`;
  assert.equal(redirect(entry,{},env,false),null);
  assert.equal(redirect(entry,{},env,'true'),null);
  assert.equal(redirect(entry,{}, {...env,PUBLIC_SHARE_ORIGIN:OLD}),null);
  assert.equal(redirect(entry,{headers:{}}),null);
  for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) assert.equal(redirect(entry,{method}),null);
  for(const [key,value] of Object.entries({Cookie:'__Host-ltds_delivery=synthetic',Authorization:'Bearer synthetic',Range:'bytes=0-1','If-Range':'synthetic',Origin:OLD}))
    assert.equal(redirect(entry,{headers:{...navigation,[key]:value}}),null,key);
  for(const path of ['/api/public/shares/id/session','/api/public/shares/id/items/item/download','/client-share/api/shares/id/session','/assets/client.js','/_ui/release/client.js','/portal','/s/id/more','/s/id%2Fmore','/s/id%252Fmore'])
    assert.equal(redirect(`${OLD}${path}`),null,path);
  for(const origin of [PORTAL,NEW,'https://unrelated.invalid']) assert.equal(redirect(`${origin}/s/id`),null);
  assert.equal(redirect(`${LTT_PORTAL}/s/id`)?.headers.get('Location'),`${NEW}/s/id`);
});

test('public callback capabilities and unknown query keys remain on their original route',()=>{
  for(const origin of [OLD,CLIENT]) for(const root of ['s','client-share']) for(const method of ['GET','HEAD'])
    for(const key of ['cloudTransferNonce','cloudTransferAuthorization','cloudTransferJob','token','%74oken','access%5Fcode','state','next','unknown','%2574oken'])
      assert.equal(redirect(`${origin}/${root}/synthetic-id?folder=opaque%2Fref&${key}=synthetic`,{method}),null,key);
});
