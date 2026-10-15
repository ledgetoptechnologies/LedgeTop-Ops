import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {OPERATIONS_CURRENT_SOURCE_MIGRATION_CHAIN} from './staging-bootstrap.mjs';

export const CONNECTOR_PROFILE203 = 'pa-ops-connectors-v203';
export const CONNECTOR_MANIFEST203 = 'PROJECT_ALPHA_CONNECTOR_SOURCES';
export const SNAPSHOT_SECRET203 = 'PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS';
export const PRIMARY_SNAPSHOT_SECRET203 = 'PROJECT_ALPHA_API_KEY';
const ORIGINS = ['https://pa-staging.ledgetoptechnologies.com','https://pa-stage-two.ledgetoptechnologies.com'];
const ALIASES = ['project-alpha:staging','project-alpha:source-2-staging'];
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;
const REF = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const fail = () => { throw new Error('Current203 connector profile is invalid or incomplete'); };
const matches = (pattern,value) => typeof value==='string'&&pattern.test(value);
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value)!==Object.prototype || Reflect.ownKeys(value).length!==keys.length) fail();
  for (const key of keys) { const d=Object.getOwnPropertyDescriptor(value,key); if(!d?.enumerable || !Object.hasOwn(d,'value')) fail(); }
}
const text = (value, max) => typeof value==='string' && value.length>0 && value.length<=max && value.trim()===value && !/[\u0000-\u001f\u007f]/.test(value);
function httpsOrigin(value) { try {const u=new URL(value);return u.protocol==='https:'&&u.origin===value&&!u.username&&!u.password;}catch{return false;} }
function canonicalPath(value) {try{const u=new URL(value,'https://invalid.test');return typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')&&!value.includes('\\')&&u.pathname===value&&!u.search&&!u.hash&&(value==='/'||!value.endsWith('/'));}catch{return false;} }

/** Public Ed25519 verification material only; never accept PEM/private JWKs. */
export function connectorPublicKeyFingerprint203(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value)) fail();
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==32||bytes.toString('base64url')!==value||bytes.every(x=>x===0)) fail();
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from('ed25519\0'),bytes])).digest('hex');
}

/** Shared byte-identical public manifest for Operations and Ops Sync. */
export function buildConnectorManifest203(metadata) {
  try {
    exact(metadata,['profile','version','sources']);
    if(metadata.profile!==CONNECTOR_PROFILE203||metadata.version!==203) fail();
    exact(metadata.sources,['stageOne','stageTwo']);
    const seen={sourceId:new Set(),producerBindingId:new Set(),credentialRef:new Set(),key:new Set()};
    const sources=['stageOne','stageTwo'].map((stage,index)=>{
      const s=metadata.sources[stage];
      exact(s,['apiV2SourceId','publicEventKey','sourceId','producerBindingId','snapshotOrigin','applicationKey','profile','displayName','enabled','readVisible','revision']);
      exact(s.revision,['credentialRef','snapshotBasePath','accessIssuer','accessAudience','accessSubject','eventCurrent']);
      exact(s.revision.eventCurrent,['keyId','algorithm','fingerprint']);
      const r=s.revision,k=r.eventCurrent;
      if(s.apiV2SourceId!==ALIASES[index]||s.snapshotOrigin!==ORIGINS[index]||!matches(SOURCE,s.sourceId)
        ||!matches(SAFE,s.producerBindingId)||!text(s.displayName,160)||!matches(REF,r.credentialRef)
        ||!matches(/^[a-z0-9][a-z0-9_-]{1,63}$/,s.applicationKey)||!canonicalPath(r.snapshotBasePath)
        ||!httpsOrigin(r.accessIssuer)||!text(r.accessAudience,512)||!text(r.accessSubject,512)
        ||typeof s.enabled!=='boolean'||typeof s.readVisible!=='boolean'||!matches(SAFE,k.keyId)||k.algorithm!=='ed25519'
        ||k.fingerprint!==connectorPublicKeyFingerprint203(s.publicEventKey)) fail();
      if(index===0?(s.sourceId!=='project-alpha:primary'||s.profile!=='primary_legacy'||s.applicationKey!=='ledgetop_ops_staging'||r.snapshotBasePath!=='/'||!s.readVisible)
        :(s.sourceId!=='project-alpha:source-2-staging'||s.profile!=='business_data')) fail();
      for(const [field,value] of [['sourceId',s.sourceId],['producerBindingId',s.producerBindingId],['credentialRef',r.credentialRef],['key',k.fingerprint]]) {
        if(seen[field].has(value)) fail();seen[field].add(value);
      }
      const {apiV2SourceId,publicEventKey,...runtime}=s;return structuredClone(runtime);
    });
    if(sources[1].enabled&&!sources[0].enabled) fail();
    const manifest=JSON.stringify({version:1,sources});if(Buffer.byteLength(manifest)>256*1024) fail();return manifest;
  }catch{return fail();}
}

export function connectorMetadataTemplate203() {
  return {profile:CONNECTOR_PROFILE203,version:203,sources:Object.fromEntries(['stageOne','stageTwo'].map((stage,i)=>[stage,{
    apiV2SourceId:ALIASES[i],publicEventKey:null,sourceId:i===0?'project-alpha:primary':'project-alpha:source-2-staging',producerBindingId:null,
    snapshotOrigin:ORIGINS[i],applicationKey:i===0?'ledgetop_ops_staging':null,profile:i===0?'primary_legacy':'business_data',
    displayName:i===0?'PA Stage One':'PA Stage Two',enabled:false,readVisible:i===0,
    revision:{credentialRef:null,snapshotBasePath:null,accessIssuer:null,accessAudience:null,accessSubject:null,
      eventCurrent:{keyId:null,algorithm:'ed25519',fingerprint:null}}}]))};
}
export function inspectConnectorMetadata203(metadata) {
  exact(metadata,['profile','version','sources']);exact(metadata.sources,['stageOne','stageTwo']);
  for(const s of Object.values(metadata.sources)){
    exact(s,['apiV2SourceId','publicEventKey','sourceId','producerBindingId','snapshotOrigin','applicationKey','profile','displayName','enabled','readVisible','revision']);
    exact(s.revision,['credentialRef','snapshotBasePath','accessIssuer','accessAudience','accessSubject','eventCurrent']);
    exact(s.revision.eventCurrent,['keyId','algorithm','fingerprint']);
  }
  if(JSON.stringify(metadata)===JSON.stringify(connectorMetadataTemplate203()))return {deployReady:false,manifest:null};
  return {deployReady:true,manifest:buildConnectorManifest203(metadata)};
}

export function parseConnectorMetadata203(raw) {
  try {
    if(typeof raw!=='string'||Buffer.byteLength(raw)>32*1024)fail();
    const parsed=JSON.parse(raw),tokens=raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);let index=0;
    function visit(){const token=tokens[index++];if(token==='{'){const keys=new Set();while(tokens[index]!=='}'){const key=JSON.parse(tokens[index++]);if(keys.has(key))fail();keys.add(key);index++;visit();if(tokens[index]===',')index++;}index++;}
      else if(token==='['){while(tokens[index]!==']'){visit();if(tokens[index]===',')index++;}index++;}}
    visit();return parsed;
  }catch{return fail();}
}

function configResourceBindings(c) {
  const out=[];
  if(c.assets?.binding)out.push([c.assets.binding,'assets']);
  for(const [field,type] of [['services','service'],['r2_buckets','r2_bucket'],['d1_databases','d1'],['workflows','workflow'],['send_email','send_email']])
    for(const row of c[field]??[])out.push([row.binding??row.name,type]);
  if(c.stream?.binding)out.push([c.stream.binding,'stream']);
  for(const row of c.queues?.producers??[])out.push([row.binding,'queue']);
  for(const row of c.durable_objects?.bindings??[])out.push([row.name,'durable_object_namespace']);
  return out;
}
/** Only public provider inventory {name,type}; no secret values accepted. */
export function buildOpsConnectorConfig203(base,metadata,inventory) {
  try {
    if(OPERATIONS_CURRENT_SOURCE_MIGRATION_CHAIN.count!==203)fail();
    const manifest=buildConnectorManifest203(metadata);
    if(base?.name!=='ledgetop-ops-staging'||base.account_id!=='846c924bf17bf4f3dd15c97a4c5d1d51'
      ||base.vars?.ENVIRONMENT!=='staging'||base.keep_vars!==false||base.vars.PROJECT_ALPHA_BASE_URL!==ORIGINS[0]
      ||base.vars.APPLICATION_KEY!=='ledgetop_ops_staging'||base.vars.STREAM_ACCOUNT_ID!==''||base.vars.STREAM_CUSTOMER_CODE!==''
      ||base.vars.STAGING_DIRECTORY_PROFILE_VIEW_GRANT_ENABLED!=='false'||base.vars.VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED!=='false')fail();
    if(Object.hasOwn(base.vars,'PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED')
      &&!['false','true'].includes(base.vars.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED))fail();
    const db=base.d1_databases?.filter(x=>x.binding==='OPS_DB');
    if(db?.length!==1||db[0].database_id!=='78b34173-b168-4e3d-9832-bb9d245cc6b8')fail();
    if(Object.hasOwn(base.vars,CONNECTOR_MANIFEST203)||Object.hasOwn(base.vars,SNAPSHOT_SECRET203)||Object.hasOwn(base.vars,PRIMARY_SNAPSHOT_SECRET203)||!Array.isArray(inventory)||inventory.length!==151)fail();
    const observed=new Map();for(const row of inventory){exact(row,['name','type']);if(!text(row.name,128)||!text(row.type,64)||observed.has(row.name))fail();observed.set(row.name,row.type);}
    const plain=Object.keys(base.vars),secrets=inventory.filter(x=>x.type==='secret_text');
    if(plain.length!==121||secrets.length!==7||observed.has(SNAPSHOT_SECRET203)||observed.has(PRIMARY_SNAPSHOT_SECRET203)||plain.some(x=>observed.get(x)!=='plain_text'))fail();
    const unsupported=['kv_namespaces','vectorize','hyperdrive','analytics_engine_datasets','dispatch_namespaces','mtls_certificates','pipelines','secrets_store_secrets','artifacts','worker_loaders','ratelimits'];
    if(unsupported.some(key=>base[key]?.length)||base.unsafe?.bindings?.length||base.ai?.binding||base.browser?.binding)fail();
    const resources=configResourceBindings(base);if(resources.length!==23||new Set(resources.map(x=>x[0])).size!==23||resources.some(([name,type])=>observed.get(name)!==type))fail();
    const resourceNames=new Set(resources.map(x=>x[0]));if(inventory.filter(x=>x.type!=='plain_text'&&x.type!=='secret_text').some(x=>!resourceNames.has(x.name)))fail();
    if(inventory.some(x=>!['plain_text','secret_text',...resources.map(x=>x[1])].includes(x.type)))fail();
    for(const key of ['PROJECT_ALPHA_CONNECTOR_CREDENTIALS','PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS'])if(Object.hasOwn(base.vars,key))fail();
    const primary=JSON.parse(manifest).sources[0];if(primary.revision.snapshotBasePath!=='/')fail();
    const config=structuredClone(base);delete config.vars.STREAM_ACCOUNT_ID;delete config.vars.STREAM_CUSTOMER_CODE;config.vars[CONNECTOR_MANIFEST203]=manifest;
    delete config.vars.STAGING_DIRECTORY_PROFILE_VIEW_GRANT_ENABLED;
    delete config.vars.VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED;
    config.vars.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED='true';
    const plainAfter=Object.keys(config.vars).length,textAfter=plainAfter+secrets.length+2,providerAfter=resources.length+textAfter;
    if(textAfter>128||providerAfter>151)fail();
    const credentialTemplate={version:1,sets:Object.fromEntries(JSON.parse(manifest).sources.map(s=>[s.revision.credentialRef,{snapshotApiKey:null}]))};
    return {profile:CONNECTOR_PROFILE203,config,manifest,credentialSecretName:SNAPSHOT_SECRET203,credentialTemplate,
      additionalSecretNames:[SNAPSHOT_SECRET203,PRIMARY_SNAPSHOT_SECRET203],
      primaryScalarCredentialBridge:{secretName:PRIMARY_SNAPSHOT_SECRET203,sameSnapshotCredentialRef:primary.revision.credentialRef,purpose:'existing primary snapshot ownership'},
      budget:{plain:plainAfter,secretsAfterSeparateInstallation:9,textBindings:textAfter,providerBindings:providerAfter},
      sourceMigrationRequirement:structuredClone(OPERATIONS_CURRENT_SOURCE_MIGRATION_CHAIN),
      remoteActionsPerformed:false,registrationRequiresOfficialAttestation:true};
  }catch{return fail();}
}

/** Check public metadata only. This CLI does not persist config or credentials. */
export function run(argv=process.argv.slice(2)) {
  if(argv.length!==3||argv[0]!=='--check'||argv[1]!=='--values')fail();
  const raw=fs.readFileSync(argv[2],'utf8');
  const result=inspectConnectorMetadata203(parseConnectorMetadata203(raw));
  console.log(JSON.stringify({profile:CONNECTOR_PROFILE203,deployReady:result.deployReady,remoteActionsPerformed:false}));return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{run();}catch{console.error('Current203 connector metadata check failed; complete official public metadata without credentials.');process.exitCode=1;}
