import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ASSET_LIMITS,addSourceReleaseProofAsset,collectFrontendAssets,validateAssetLedger,mergeAssetLedger,preserveRootHtmlArchive,providerManifest,ledgerBytes} from './production-auto-assets.mjs';
const workerName='ledgetop-ops',accountId='a'.repeat(32),sourceCommit='b'.repeat(40),parentVersionId='11111111-2222-4333-8444-555555555555',observedAt='2026-10-23T12:00:00.000Z';
const identity={workerName,accountId};const meta={...identity,sourceCommit,parentVersionId,observedAt};
const hash=b=>createHash('sha256').update(b).digest('hex');
const faviconBytes=fs.readFileSync(fileURLToPath(new URL('../apps/operations/public/favicon.ico',import.meta.url)));
const clone=v=>JSON.parse(JSON.stringify(v));
function inventory(files={'/index.html':'html','/assets/old.js':'old'}) {const payloads=new Map(Object.entries(files).map(([p,b])=>[p,Buffer.from(b)]));const entries=[...payloads].map(([p,b])=>({path:p,size:b.length,sha256:hash(b),mime:p.endsWith('.html')?'text/html':'text/javascript',providerHash:hash(b).slice(0,32)})).sort((a,b)=>a.path<b.path?-1:1);return{entries,payloads};}
function faviconInventory(mime,p='/favicon.ico',bytes=faviconBytes) {const payloads=new Map([[p,Buffer.from(bytes)],['/index.html',Buffer.from('html')]]);const entries=[...payloads].map(([path,b])=>({path,size:b.length,sha256:hash(b),mime:path===p?mime:'text/html',providerHash:hash(b).slice(0,32)})).sort((a,b)=>a.path<b.path?-1:1);return{entries,payloads};}
const ledger=()=>mergeAssetLedger({...meta,previous:null,current:inventory()});
function fixture(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'production-auto-assets-'));try{fs.writeFileSync(path.join(root,'.assetsignore'),'wrangler.json\n.dev.vars\n');fs.writeFileSync(path.join(root,'index.html'),'html');fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'assets','old.js'),'old');return fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('collects genuine frontend bytes, MIME and custom SHA256-prefix provider hash; excludes only pinned root controls',()=>fixture(root=>{fs.writeFileSync(path.join(root,'wrangler.json'),'not uploaded');fs.writeFileSync(path.join(root,'.dev.vars'),'not read or uploaded');const c=collectFrontendAssets(root);assert.deepEqual(c.entries,inventory().entries);assert.deepEqual([...c.payloads.keys()].sort(),['/assets/old.js','/index.html']);assert.equal(c.payloads.get('/assets/old.js').toString(),'old');}));
test('collects the pinned favicon with canonical native Worker MIME',()=>fixture(root=>{fs.copyFileSync(fileURLToPath(new URL('../apps/operations/public/favicon.ico',import.meta.url)),path.join(root,'favicon.ico'));const icon=collectFrontendAssets(root).entries.find(x=>x.path==='/favicon.ico');assert.equal(icon.size,1889);assert.equal(icon.sha256,'4475e1abc388373b2e6c77b91e229e55e65b4efa1435e5aa816056873ad30e36');assert.equal(icon.mime,'image/vnd.microsoft.icon');}));
test('JavaScript and module JavaScript use the live text/javascript MIME',()=>fixture(root=>{fs.writeFileSync(path.join(root,'assets','module.mjs'),'module');const c=collectFrontendAssets(root);assert.equal(c.entries.find(e=>e.path==='/assets/old.js').mime,'text/javascript');assert.equal(c.entries.find(e=>e.path==='/assets/module.mjs').mime,'text/javascript');}));
test('requires exact pinned assetsignore rather than arbitrary ignored paths',()=>fixture(root=>{fs.writeFileSync(path.join(root,'.assetsignore'),'**/*\n');assert.throws(()=>collectFrontendAssets(root),/ignore_policy/);}));
test('accepts CRLF pinned ignore and never uploads it',()=>fixture(root=>{fs.writeFileSync(path.join(root,'.assetsignore'),'wrangler.json\r\n.dev.vars\r\n');assert.equal(collectFrontendAssets(root).entries.length,2);}));
test('rejects missing ignore file',()=>fixture(root=>{fs.unlinkSync(path.join(root,'.assetsignore'));assert.throws(()=>collectFrontendAssets(root));}));
test('rejects nested control files and hidden credential paths',()=>fixture(root=>{fs.writeFileSync(path.join(root,'assets','.dev.vars'),'secret');assert.throws(()=>collectFrontendAssets(root),/path_unsafe/);}));
test('rejects regular-file replacements for directories',()=>fixture(root=>assert.throws(()=>collectFrontendAssets(path.join(root,'index.html')),/nonregular/)));
test('rejects directory symlinks/junctions without following their bytes',()=>fixture(root=>{fs.symlinkSync(path.join(root,'assets'),path.join(root,'linked'),process.platform==='win32'?'junction':'dir');assert.throws(()=>collectFrontendAssets(root),/nonregular/);}));
test('rejects hardlinks',()=>fixture(root=>{fs.linkSync(path.join(root,'index.html'),path.join(root,'assets','linked.js'));assert.throws(()=>collectFrontendAssets(root),/nonregular/);}));
test('rejects oversized files before reading bytes',()=>fixture(root=>{const f=path.join(root,'assets','large.js');fs.writeFileSync(f,'');fs.truncateSync(f,ASSET_LIMITS.fileBytes+1);assert.throws(()=>collectFrontendAssets(root),/file_size/);}));
test('canonical JSON round trips with exact worker/account identity',()=>{const l=ledger();assert.deepEqual(validateAssetLedger(JSON.parse(ledgerBytes(l)),identity),l);assert.equal(ledgerBytes(l).toString(),JSON.stringify(l)+'\n');assert.deepEqual(providerManifest(l),Object.fromEntries(l.assets.map(a=>[a.path,{hash:a.providerHash,size:a.size}])));});
test('holds on wrong identities, policy, metadata and unknown/prototype keys',()=>{for(const change of[{workerName:'other'},{accountId:'c'.repeat(32)},{minimumRetentionHours:47},{minimumRetentionHours:72},{automaticPruning:true},{schemaVersion:2},{sourceCommit:'x'},{parentVersionId:'x'},{observedAt:'2026-10-23'},{extra:true}])assert.throws(()=>validateAssetLedger({...ledger(),...change},identity));const polluted=clone(ledger());Object.defineProperty(polluted,'__proto__',{value:'no',enumerable:true});assert.throws(()=>validateAssetLedger(polluted,identity));assert.throws(()=>validateAssetLedger(Object.assign(Object.create({}),ledger()),identity));});
test('rejects malformed asset paths including encoded traversal and provider controls',()=>{for(const p of['/../x','/assets/./x','/assets//x','//host/x','/x%2Ejs','/x?y','/x#y','/x\\y','/x\ny','/assets/.env','/wrangler.json','/_headers','/constructor/x','/__proto__/x','/prototype','/x.pem','/assets/NUL.js','/assets/x.']){const l=ledger();l.assets[0].path=p;assert.throws(()=>validateAssetLedger(l,identity),p);}});
test('rejects duplicate, case-colliding, unsorted and prototype-bearing entry records',()=>{for(const mutate of[l=>l.assets.push(clone(l.assets[0])),l=>l.assets.reverse(),l=>l.assets.unshift({...l.assets[0],path:'/assets/OLD.js'}),l=>l.assets[0]={...l.assets[0],extra:true},l=>Object.setPrototypeOf(l.assets[0],{extra:true}),l=>Object.defineProperty(l.assets,'extra',{value:true})]){const l=ledger();mutate(l);assert.throws(()=>validateAssetLedger(l,identity));}});
test('requires bounded counts, byte totals, MIME and index',()=>{for(const mutate of[l=>l.assets=[],l=>l.assets=l.assets.filter(a=>a.path!='/index.html'),l=>l.assets[0].size=-1,l=>l.assets[0].size=ASSET_LIMITS.fileBytes+1,l=>l.assets[0].mime='text/html\r\nX: y',l=>l.assets[0].providerHash='x',l=>l.assets[0].sha256='x']){const l=ledger();mutate(l);assert.throws(()=>validateAssetLedger(l,identity));}const l=ledger();l.assets=Array.from({length:17},(_,i)=>({...l.assets[0],path:'/assets/'+String(i).padStart(2,'0')+'.js',size:ASSET_LIMITS.fileBytes}));l.assets.push({...ledger().assets[1]});assert.throws(()=>validateAssetLedger(l,identity),/total_bytes/);});
test('carries ALL historical bytes and opaque provider hashes, replacing only index',()=>{const prior=ledger();prior.assets[0].providerHash='c'.repeat(32);const current=inventory({'/index.html':'new html','/assets/new.js':'new'});current.payloads.set('/assets/old.js',Buffer.from('old'));const next=mergeAssetLedger({...meta,observedAt:'2026-10-26T12:00:00.000Z',previous:prior,current});assert.deepEqual(next.assets.map(a=>a.path),['/assets/new.js','/assets/old.js','/index.html']);assert.equal(next.assets[1].providerHash,'c'.repeat(32));assert.equal(next.minimumRetentionHours,48);assert.equal(next.automaticPruning,false);assert.equal(next.assets[2].sha256,hash(Buffer.from('new html')));});
test('archives changed prior root HTML immutably and carries it through subsequent roll-forward',()=>{
  const priorCurrent=inventory({'/index.html':'old raw index','/assets/old.js':'old bundle'});
  const prior=mergeAssetLedger({...meta,previous:null,current:priorCurrent});prior.assets.find(row=>row.path==='/index.html').providerHash='c'.repeat(32);
  const current=inventory({'/index.html':'new root','/assets/new.js':'new bundle'});current.payloads.set('/assets/old.js',Buffer.from('old bundle'));
  const preserved=preserveRootHtmlArchive({application:'operations',previous:prior,previousAssetBytes:priorCurrent.payloads,current});
  assert.deepEqual(preserved.archive,{sourcePath:'/index.html',path:`/_ui/operations/${hash(Buffer.from('old raw index')).slice(0,40)}/index.html`,size:13,
    sha256:hash(Buffer.from('old raw index')),mime:'text/html',transportPath:`/_ui/operations/${hash(Buffer.from('old raw index')).slice(0,40)}/`});
  const first=mergeAssetLedger({...meta,observedAt:'2026-10-26T12:00:00.000Z',previous:prior,current:preserved.current});
  assert.equal(first.assets.find(row=>row.path==='/index.html').providerHash,hash(Buffer.from('new root')).slice(0,32));
  assert.equal(first.assets.find(row=>row.path===preserved.archive.path).providerHash,hash(Buffer.from('old raw index')).slice(0,32));
  assert.equal(preserved.current.payloads.get(preserved.archive.path).toString(),'old raw index');
  const nextPriorBytes=new Map(preserved.current.payloads);
  const nextBuild=inventory({'/index.html':'third root','/assets/new.js':'new bundle'});
  const secondPreserved=preserveRootHtmlArchive({application:'operations',previous:first,previousAssetBytes:nextPriorBytes,current:nextBuild});
  const second=mergeAssetLedger({...meta,observedAt:'2026-10-27T12:00:00.000Z',previous:first,current:secondPreserved.current});
  assert.equal(nextPriorBytes.get(preserved.archive.path).toString(),'old raw index');
  assert.equal(second.assets.find(row=>row.path===preserved.archive.path).sha256,hash(Buffer.from('old raw index')));
  assert.equal(second.assets.find(row=>row.path===secondPreserved.archive.path).sha256,hash(Buffer.from('new root')));
  assert.equal(second.assets.find(row=>row.path==='/index.html').sha256,hash(Buffer.from('third root')));
});
test('does not create a redundant archive for unchanged root and refuses archive namespace collisions',()=>{
  const current=inventory(),prior=mergeAssetLedger({...meta,previous:null,current});
  const unchanged=preserveRootHtmlArchive({application:'operations',previous:prior,previousAssetBytes:current.payloads,current:inventory()});
  assert.equal(unchanged.archive,null);
  const digest=hash(Buffer.from('html'));
  const collision=inventory({'/index.html':'new',[`/_ui/operations/${digest.slice(0,40)}/index.html`]:'attacker'});
  assert.throws(()=>preserveRootHtmlArchive({application:'operations',previous:prior,previousAssetBytes:current.payloads,current:collision}),/archive_collision/);
});
test('source release proof distinguishes backend-only commits while carrying identical frontend bytes',()=>{
  const firstSource='c'.repeat(40),secondSource='d'.repeat(40),current=inventory();
  const first=addSourceReleaseProofAsset({application:'operations',sourceCommit:firstSource,parentVersionId,current});
  const previous=mergeAssetLedger({...meta,sourceCommit:firstSource,previous:null,current:first});
  const next=addSourceReleaseProofAsset({application:'operations',sourceCommit:secondSource,parentVersionId:'22222222-3333-4333-8444-555555555555',current:inventory()});
  const retained=preserveRootHtmlArchive({application:'operations',previous,previousAssetBytes:first.payloads,current:next});
  const newer=mergeAssetLedger({...meta,sourceCommit:secondSource,parentVersionId:'22222222-3333-4333-8444-555555555555',
    observedAt:'2026-10-24T12:00:00.000Z',previous,current:retained.current});
  assert.equal(newer.assets.find(row=>row.path==='/index.html').sha256,previous.assets.find(row=>row.path==='/index.html').sha256);
  assert.ok(newer.assets.some(row=>row.path===`/_ui/operations/${firstSource}/release.json`));
  assert.ok(newer.assets.some(row=>row.path===`/_ui/operations/${secondSource}/release.json`));
  const proof=JSON.parse(retained.current.payloads.get(`/_ui/operations/${secondSource}/release.json`).toString());
  assert.deepEqual(proof,{schemaVersion:1,workerName:'ledgetop-ops',sourceCommit:secondSource,
    parentVersionId:'22222222-3333-4333-8444-555555555555'});
  assert.equal(newer.assets.find(row=>row.path===`/_ui/operations/${secondSource}/release.json`).mime,'application/json');
  assert.notEqual(newer.assets.find(row=>row.path===`/_ui/operations/${firstSource}/release.json`).sha256,
    newer.assets.find(row=>row.path===`/_ui/operations/${secondSource}/release.json`).sha256);
});
test('source release proof refuses reserved namespace, wrong identity and incomplete payload collisions',()=>{
  const source='c'.repeat(40);
  assert.throws(()=>addSourceReleaseProofAsset({application:'ops-sync',sourceCommit:source,parentVersionId,current:inventory()}),/release_proof_input_invalid/);
  assert.throws(()=>addSourceReleaseProofAsset({application:'operations',sourceCommit:'C'.repeat(40),parentVersionId,current:inventory()}),/release_proof_input_invalid/);
  assert.throws(()=>addSourceReleaseProofAsset({application:'operations',sourceCommit:source,parentVersionId,
    current:inventory({'/index.html':'html',[`/_ui/operations/${'e'.repeat(40)}/release.json`]:'collision'})}),/reserved_namespace_collision/);
  const damaged=inventory();damaged.payloads.set('/unlisted.js',Buffer.from('extra'));
  assert.throws(()=>addSourceReleaseProofAsset({application:'operations',sourceCommit:source,parentVersionId,current:damaged}),/payload_inventory_invalid/);
});
test('holds when an old byte payload is missing instead of dropping its path',()=>assert.throws(()=>mergeAssetLedger({...meta,previous:ledger(),current:inventory({'/index.html':'new'})}),/payload_inventory|payload_missing/));
test('holds on historical changed bytes, metadata or case collisions',()=>{for(const files of[{'/index.html':'new','/assets/old.js':'CHANGED'},{'/index.html':'new','/assets/OLD.js':'old'}])assert.throws(()=>mergeAssetLedger({...meta,previous:ledger(),current:inventory(files)}),/historical_path_changed|case_collision/);const current=inventory();current.entries[0].mime='text/plain';assert.throws(()=>mergeAssetLedger({...meta,previous:ledger(),current}),/historical_path_changed/);});
test('migrates only the exact retained favicon MIME alias and preserves its old provider identifier',()=>{const previous=mergeAssetLedger({...meta,previous:null,current:faviconInventory('image/x-icon')});const priorIcon=previous.assets.find(row=>row.path==='/favicon.ico');priorIcon.providerHash='c'.repeat(32);const current=faviconInventory('image/vnd.microsoft.icon');const next=mergeAssetLedger({...meta,observedAt:'2026-10-26T12:00:00.000Z',previous,current});const nextIcon=next.assets.find(row=>row.path==='/favicon.ico');assert.equal(nextIcon.mime,'image/vnd.microsoft.icon');assert.equal(nextIcon.providerHash,'c'.repeat(32));});
test('favicon MIME alias does not relax path or byte identity checks',()=>{for(const [priorPath,currentPath,priorBytes,currentBytes] of [['/assets/favicon.ico','/assets/favicon.ico',faviconBytes,faviconBytes],['/favicon.ico','/favicon.ico',faviconBytes,Buffer.from('different icon')]]){const previous=mergeAssetLedger({...meta,previous:null,current:faviconInventory('image/x-icon',priorPath,priorBytes)});assert.throws(()=>mergeAssetLedger({...meta,previous,current:faviconInventory('image/vnd.microsoft.icon',currentPath,currentBytes)}),/historical_path_changed/);}});
test('does not recompute opaque provider hashes even when new build has identical bytes',()=>{const prior=ledger();prior.assets[0].providerHash='c'.repeat(32);const next=mergeAssetLedger({...meta,previous:prior,current:inventory()});assert.equal(next.assets[0].providerHash,'c'.repeat(32));});
test('holds mismatched payload digest, missing payloads, injected extras and fabricated new provider hashes',()=>{for(const mutate of[c=>c.payloads.set('/assets/old.js',Buffer.from('bad')),c=>c.payloads.delete('/index.html'),c=>c.payloads.set('/extra.js',Buffer.from('extra')),c=>c.entries[0].providerHash='c'.repeat(32)]){const current=inventory();mutate(current);assert.throws(()=>mergeAssetLedger({...meta,previous:null,current}));}});
test('holds provider-hash collision with distinct bytes',()=>{const l=ledger();l.assets[1].providerHash=l.assets[0].providerHash;assert.throws(()=>validateAssetLedger(l,identity),/provider_hash_collision/);});
test('refuses time regression and does not mutate supplied inventories or prior ledger',()=>{const previous=ledger(),current=inventory();const before=JSON.stringify(previous),entries=JSON.stringify(current.entries);mergeAssetLedger({...meta,previous,current});assert.equal(JSON.stringify(previous),before);assert.equal(JSON.stringify(current.entries),entries);assert.throws(()=>mergeAssetLedger({...meta,observedAt:'2026-10-22T12:00:00.000Z',previous,current}),/time_regressed/);});
