/** Pure retention ledger: no uploads, activation or automatic pruning.
 * New provider hashes use sha256-prefix32-v1, a custom 32-hex direct-upload
 * identifier, NOT Wrangler's BLAKE3 algorithm. Existing opaque hashes survive.
 * https://developers.cloudflare.com/workers/static-assets/direct-upload/
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ASSET_LIMITS = Object.freeze({ files: 20_000, fileBytes: 32 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024, ledgerBytes: 8 * 1024 * 1024 });
const SHA = /^[a-f0-9]{64}$/u, HASH = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const LEDGER_KEYS = ['schemaVersion','workerName','accountId','sourceCommit','parentVersionId','observedAt','minimumRetentionHours','automaticPruning','assets'];
const ENTRY_KEYS = ['path','size','sha256','mime','providerHash'];
const CONTROL = new Set(['.assetsignore','.dev.vars','wrangler.json']);
const IGNORE = 'wrangler.json\n.dev.vars\n';
const MIMES = Object.freeze({ '.html':'text/html', '.htm':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.map':'application/json', '.webmanifest':'application/manifest+json',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
  '.webp':'image/webp', '.avif':'image/avif', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2',
  '.ttf':'font/ttf', '.otf':'font/otf', '.wasm':'application/wasm', '.txt':'text/plain', '.xml':'application/xml',
  '.pdf':'application/pdf', '.mp4':'video/mp4', '.webm':'video/webm', '.mp3':'audio/mpeg', '.wav':'audio/wav' });
const need = (ok, code) => { if (!ok) throw new Error(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sort = (a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(k => Object.hasOwn(value,k)) && keys.every(k => Object.getOwnPropertyDescriptor(value,k)?.get === undefined
      && Object.getOwnPropertyDescriptor(value,k)?.set === undefined);
}
function identity(workerName, accountId) {
  need(typeof workerName==='string' && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(workerName), 'asset_worker_identity_invalid');
  need(typeof accountId==='string' && HASH.test(accountId), 'asset_account_identity_invalid');
}
function assetPath(value) {
  need(typeof value==='string' && value.length<=1024 && /^\/[A-Za-z0-9._/-]+$/u.test(value)
    && !value.includes('//') && !value.endsWith('/'), 'asset_path_invalid');
  for (const part of value.slice(1).split('/')) {
    need(part && !part.startsWith('.') && !/[. ]$/u.test(part) && !['__proto__','prototype','constructor'].includes(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
      && !CONTROL.has(part.toLowerCase()) && !/^(?:_headers|_redirects|wrangler(?:\..*)?|package(?:-lock)?\.json)$/iu.test(part)
      && !/\.(?:env|pem|key|pfx|p12)$/iu.test(part), 'asset_path_unsafe');
  }
  return value;
}
function entries(values) {
  need(Array.isArray(values) && values.length>0 && values.length<=ASSET_LIMITS.files,'asset_inventory_count_invalid');
  need(Object.getPrototypeOf(values)===Array.prototype && Reflect.ownKeys(values).length===values.length+1,'asset_inventory_shape_invalid');
  const seen=new Set(), hashes=new Map(); let total=0,prior=null;
  for(const v of values) {
    need(exact(v,ENTRY_KEYS),'asset_entry_shape_invalid'); assetPath(v.path);
    need(prior===null || prior<v.path,'asset_entries_not_strictly_sorted');prior=v.path;
    need(!seen.has(v.path.toLowerCase()),'asset_path_case_collision');seen.add(v.path.toLowerCase());
    need(Number.isSafeInteger(v.size)&&v.size>=0&&v.size<=ASSET_LIMITS.fileBytes,'asset_file_size_invalid');
    total+=v.size;need(total<=ASSET_LIMITS.totalBytes,'asset_total_bytes_exceeded');
    need(typeof v.sha256==='string'&&SHA.test(v.sha256)&&typeof v.providerHash==='string'&&HASH.test(v.providerHash),'asset_digest_invalid');
    need(typeof v.mime==='string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(v.mime) && v.mime.length<=128,'asset_mime_invalid');
    const oldHash=hashes.get(v.providerHash);
    need(!oldHash || oldHash.sha256===v.sha256 && oldHash.size===v.size && oldHash.mime===v.mime,'asset_provider_hash_collision');
    hashes.set(v.providerHash,v);
  }
  need(values.some(v=>v.path==='/index.html'),'asset_index_missing');
  return values.map(v=>({path:v.path,size:v.size,sha256:v.sha256,mime:v.mime,providerHash:v.providerHash}));
}
function canonicalLedger(v) { return {schemaVersion:1,workerName:v.workerName,accountId:v.accountId,sourceCommit:v.sourceCommit,
  parentVersionId:v.parentVersionId,observedAt:v.observedAt,minimumRetentionHours:48,automaticPruning:false,assets:entries(v.assets)}; }
export function validateAssetLedger(ledger, expected) {
  need(exact(expected,['workerName','accountId']),'asset_expected_identity_invalid');identity(expected.workerName,expected.accountId);
  need(exact(ledger,LEDGER_KEYS)&&ledger.schemaVersion===1,'asset_ledger_shape_invalid');
  need(ledger.workerName===expected.workerName&&ledger.accountId===expected.accountId,'asset_ledger_identity_mismatch');
  need(typeof ledger.sourceCommit==='string'&&/^[a-f0-9]{40}$/u.test(ledger.sourceCommit)&&typeof ledger.parentVersionId==='string'&&UUID.test(ledger.parentVersionId),'asset_source_identity_invalid');
  need(typeof ledger.observedAt==='string'&&ledger.observedAt.length===24&&Number.isFinite(Date.parse(ledger.observedAt))&&new Date(ledger.observedAt).toISOString()===ledger.observedAt,'asset_observation_time_invalid');
  need(ledger.minimumRetentionHours===48&&ledger.automaticPruning===false,'asset_retention_policy_invalid');
  const result=canonicalLedger(ledger);need(Buffer.byteLength(JSON.stringify(result)+'\n')<=ASSET_LIMITS.ledgerBytes,'asset_ledger_bytes_exceeded');return result;
}
function regular(file, directory=false) {
  const st=fs.lstatSync(file);need(!st.isSymbolicLink()&&(directory?st.isDirectory():st.isFile()&&st.nlink===1),'asset_nonregular_path');return st;
}
function rootDirectory(directory) {
  need(typeof directory==='string'&&path.isAbsolute(directory)&&! /^(?:\\\\|\/\/)/u.test(directory),'asset_local_absolute_directory_required');
  const root=path.resolve(directory);for(let p=root;;p=path.dirname(p)){regular(p,true);if(path.dirname(p)===p)break;}return root;
}
function bytesFromFile(file,st) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try {const opened=fs.fstatSync(fd);need(opened.isFile()&&opened.nlink===1&&opened.ino===st.ino&&opened.dev===st.dev&&opened.size===st.size&&opened.mtimeMs===st.mtimeMs,'asset_changed_during_read');
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);need(bytes.length===st.size&&after.size===st.size&&after.mtimeMs===st.mtimeMs&&after.ctimeMs===st.ctimeMs,'asset_changed_during_read');
    const final=regular(file);need(final.ino===st.ino&&final.dev===st.dev&&final.size===st.size&&final.mtimeMs===st.mtimeMs,'asset_changed_during_read');return bytes;
  } finally {fs.closeSync(fd);}
}
export function collectFrontendAssets(directory) {
  const root=rootDirectory(directory),result=[],payloads=new Map();let total=0,count=0;
  const ignorePath=path.join(root,'.assetsignore'),ignoreStat=regular(ignorePath);need(ignoreStat.size<=128,'asset_ignore_policy_invalid');
  need(bytesFromFile(ignorePath,ignoreStat).toString('utf8').replaceAll('\r\n','\n')===IGNORE,'asset_ignore_policy_invalid');
  function walk(dir) {for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
    need(++count<=ASSET_LIMITS.files+100,'asset_tree_count_exceeded');const full=path.join(dir,item.name),st=fs.lstatSync(full);
    need(!st.isSymbolicLink(),'asset_nonregular_path');
    if(dir===root&&CONTROL.has(item.name)) {regular(full);continue;}
    const url=assetPath('/'+path.relative(root,full).split(path.sep).join('/'));
    if(st.isDirectory()){walk(full);continue;}regular(full);
    need(st.size<=ASSET_LIMITS.fileBytes&&result.length<ASSET_LIMITS.files,'asset_file_size_invalid');total+=st.size;need(total<=ASSET_LIMITS.totalBytes,'asset_total_bytes_exceeded');
    const bytes=bytesFromFile(full,st),digest=sha(bytes);payloads.set(url,bytes);
    result.push({path:url,size:bytes.length,sha256:digest,mime:MIMES[path.extname(url).toLowerCase()]??'application/octet-stream',providerHash:digest.slice(0,32)});
  }}walk(root);result.sort(sort);entries(result);return {entries:result,payloads};
}
function verifiedBytes(v,payloads) {const bytes=payloads.get(v.path);need(Buffer.isBuffer(bytes)&&bytes.length===v.size&&sha(bytes)===v.sha256,'asset_payload_missing_or_changed');return bytes;}
/** Previous JSON must be externally tied to a verified complete live inventory.
 * This pure builder cannot prove that bootstrap or any remote association.
 * current.entries lists the new build; current.payloads must also contain every
 * historical byte payload retained by the coordinator. No path ages out here. */
export function mergeAssetLedger({previous,current,workerName,accountId,sourceCommit,parentVersionId,observedAt}) {
  identity(workerName,accountId);need(exact(current,['entries','payloads'])&&current.payloads instanceof Map,'asset_current_inventory_invalid');
  const incoming=entries(current.entries), prior=previous===null?null:validateAssetLedger(previous,{workerName,accountId});
  const union=new Map(),casePaths=new Map();
  for(const v of prior?.assets??[]) {union.set(v.path,v);casePaths.set(v.path.toLowerCase(),v.path);}
  for(const v of incoming) {
    const bytes=verifiedBytes(v,current.payloads),old=union.get(v.path),collision=casePaths.get(v.path.toLowerCase());
    need(!collision||collision===v.path,'asset_path_case_collision');
    need(v.providerHash===sha(bytes).slice(0,32),'asset_new_provider_hash_invalid');
    need(!old||v.path==='/index.html'||old.size===v.size&&old.sha256===v.sha256&&old.mime===v.mime,'asset_historical_path_changed');
    union.set(v.path,old&&old.size===v.size&&old.sha256===v.sha256&&old.mime===v.mime?old:v);casePaths.set(v.path.toLowerCase(),v.path);
  }
  const merged=[...union.values()].sort(sort);entries(merged);
  need(current.payloads.size===merged.length,'asset_payload_inventory_not_exact');
  for(const v of merged)verifiedBytes(v,current.payloads);
  if(prior)need(Date.parse(observedAt)>=Date.parse(prior.observedAt),'asset_observation_time_regressed');
  return validateAssetLedger({schemaVersion:1,workerName,accountId,sourceCommit,parentVersionId,observedAt,
    minimumRetentionHours:48,automaticPruning:false,assets:merged},{workerName,accountId});
}
export function providerManifest(ledger) {
  const valid=validateAssetLedger(ledger,{workerName:ledger?.workerName,accountId:ledger?.accountId});
  return Object.fromEntries(valid.assets.map(v=>[v.path,{hash:v.providerHash,size:v.size}]));
}
export function ledgerBytes(ledger) {
  const valid=validateAssetLedger(ledger,{workerName:ledger?.workerName,accountId:ledger?.accountId});return Buffer.from(JSON.stringify(valid)+'\n','utf8');
}
