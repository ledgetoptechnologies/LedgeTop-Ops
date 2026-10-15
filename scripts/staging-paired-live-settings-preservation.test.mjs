import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { buildPairedEndToEndAcceptanceConfigs } from "./staging-paired-end-to-end-acceptance-profile.mjs";
import { VIEWER_ACCEPTANCE_SECRET_NAMES } from "./staging-project-alpha-api-v2-viewer-acceptance-profile.mjs";
import {
  buildPairedLiveSettingsPreservedConfig as overlay,
  validatePairedLiveSettingsPreservedConfig as validateOverlay,
} from "./staging-paired-live-settings-preservation.mjs";

const root = path.resolve(import.meta.dirname, "..");
const ov = "5f0ad270-0092-4f51-9534-34efc6ee2957";
const cv = "8bf70f8c-c3c5-494d-8c4b-474427f86350";
const values={DELIVERY_STAGING_ACCESS_AUD:"a".repeat(64),OPERATIONS_STAGING_ACCESS_AUD:"b".repeat(64),PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD:"c".repeat(64),DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD:"d".repeat(64),STAGING_PROJECT_ALPHA_SOURCE_ID:"project-alpha:staging",STAGING_PROJECT_ALPHA_HTTPS_ORIGIN:"https://pa-staging.ledgetoptechnologies.com",CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN:"pk.client-staging",OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN:"pk.operations-staging",MAPBOX_STAGING_ACCEPTANCE_DEFERRED:"false",STAGING_EMAIL_DOMAIN:"staging.example.test",STAGING_TRIAGE_EMAIL:"triage@staging.example.test",STAGING_ACCESS_GROUP_ID:"11111111-1111-4111-8111-111111111111",STAGING_ACCESS_GROUP_NAME:"LTDS staging operators"};
function fixture(){const r=renderConfigs(root,values),f={sources:{delivery:r.delivery,operations:r.operations},production:{delivery:JSON.parse(fs.readFileSync(path.join(root,"apps/client/wrangler.jsonc"),"utf8")),operations:JSON.parse(fs.readFileSync(path.join(root,"apps/operations/wrangler.jsonc"),"utf8"))},secretNames:{names:[...VIEWER_ACCEPTANCE_SECRET_NAMES]}};return{...f,pair:buildPairedEndToEndAcceptanceConfigs(f.sources,f.production,f.secretNames)}}
const preflight=()=>({operations:{workerName:"ledgetop-ops-staging",activeVersionId:ov},delivery:{workerName:"ledgetop-clients-staging",activeVersionId:cv}});
const snapshot=()=>({schemaVersion:1,environment:"staging",worker:{operations:{name:"ledgetop-ops-staging",versionId:ov},delivery:{name:"ledgetop-clients-staging",versionId:cv}},settings:{operations:{VIEWER_PUBLIC_SHARES_ENABLED:"true",CLIENT_VIEWER_SESSION_ISSUER_ENABLED:"true",CLIENT_VIEWER_SHARES_ENABLED:"true"},delivery:{CLIENT_VIEWER_ENABLED:"false",CLIENT_VIEWER_SHARES_ENABLED:"false"}}});
const build=(f,s=snapshot(),p=preflight())=>overlay(f.sources,f.pair,f.production,f.secretNames,s,p);
const validate=(f,c,s=snapshot(),p=preflight())=>validateOverlay(f.sources,f.pair,c,f.production,f.secretNames,s,p);
test("preserves exactly five booleans from a validated pair",()=>{const f=fixture(),before=structuredClone(f.pair),r=build(f);assert.deepEqual(f.pair,before);assert.equal(r.operations.vars.VIEWER_PUBLIC_SHARES_ENABLED,"true");assert.equal(r.operations.vars.CLIENT_VIEWER_SESSION_ISSUER_ENABLED,"true");assert.equal(r.operations.vars.CLIENT_VIEWER_SHARES_ENABLED,"true");assert.equal(r.delivery.vars.CLIENT_VIEWER_ENABLED,"false");assert.equal(r.delivery.vars.CLIENT_VIEWER_SHARES_ENABLED,"false");assert.equal(r.operations.vars.VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED,"false");assert.deepEqual(validate(f,r),[])});
test("rejects missing extra duplicate-equivalent and invalid settings",()=>{const f=fixture(),m=snapshot();delete m.settings.operations.VIEWER_PUBLIC_SHARES_ENABLED;assert.throws(()=>build(f,m),/exactly the selected/);const e=snapshot();e.settings.operations.VIEWER_PROCESSING_ENABLED="true";assert.throws(()=>build(f,e),/exactly the selected/);const i=snapshot();i.settings.delivery.CLIENT_VIEWER_ENABLED=true;assert.throws(()=>build(f,i),/explicit string/);const d=snapshot();d.settings.operations=[["VIEWER_PUBLIC_SHARES_ENABLED","true"],["VIEWER_PUBLIC_SHARES_ENABLED","true"]];assert.throws(()=>build(f,d),/exactly the selected/)});
test("rejects inversion of every reviewed live boolean", () => {
  const f = fixture();
  for (const [app, names] of Object.entries({
    operations: ["VIEWER_PUBLIC_SHARES_ENABLED", "CLIENT_VIEWER_SESSION_ISSUER_ENABLED", "CLIENT_VIEWER_SHARES_ENABLED"],
    delivery: ["CLIENT_VIEWER_ENABLED", "CLIENT_VIEWER_SHARES_ENABLED"],
  })) for (const name of names) {
    const changed = snapshot();
    changed.settings[app][name] = changed.settings[app][name] === "true" ? "false" : "true";
    assert.throws(() => build(f, changed), /differs from the exact reviewed active-version value/, `${app}.${name}`);
  }
});
test("rejects unknown fields secrets and production workers",()=>{const f=fixture(),u=snapshot();u.note="x";assert.throws(()=>build(f,u),/contain only/);const s=snapshot();s.settings.operations.VIEWER_SERVICE_HMAC_SECRET="secret";assert.throws(()=>build(f,s),/exactly the selected/);const p=snapshot();p.worker.operations.name="ledgetop-ops";assert.throws(()=>build(f,p),/exact reviewed staging operations version/)});
test("requires exact active versions for both workers",()=>{const f=fixture(),p=preflight();p.operations.activeVersionId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";assert.throws(()=>build(f,snapshot(),p),/snapshot is stale/);const s=snapshot();s.worker.delivery.versionId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";assert.throws(()=>build(f,s),/exact reviewed staging delivery version/)});
test("rejects unvalidated baselines and unauthorized candidate drift",()=>{const f=fixture(),b=structuredClone(f.pair);b.operations.vars.VIEWER_PROCESSING_ENABLED="false";assert.throws(()=>overlay(f.sources,b,f.production,f.secretNames,snapshot(),preflight()),/baseline is not validated/);const c=build(f);c.operations.vars.VIEWER_PROCESSING_ENABLED="false";assert.equal(validate(f,c).length,1);const x=build(f);x.delivery.services.push({binding:"UNAUTHORIZED",service:"wrong"});assert.equal(validate(f,x).length,1)});
