import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ASSET_VERIFICATION_LIMITS, createAssetVerificationNonce, createAssetVerifierSource, collectVerifiedAssets, executeAssetVerification } from "./production-auto-verify.mjs";

const bytes = Buffer.from([0, 255, 13, 10, 65, 0]);
const sha = value => createHash("sha256").update(value).digest("hex");
const faviconBytes = fs.readFileSync(fileURLToPath(new URL('../apps/operations/public/favicon.ico', import.meta.url)));
const entry = { path: "/assets/old-build.js", size: bytes.length, sha256: sha(bytes), contentType: "application/javascript" };
const versionId = "00000000-0000-4000-8000-000000000001";
const options = nonce => ({ workerName: "ledgetop-ops", origin: "https://ops.ledgetop.app", entries: [entry], nonceHash: nonce.nonceHash, versionId });
const response = (method, body = bytes, headers = {}) => new Response(method === "HEAD" ? null : body, {
  headers: { "Content-Type": entry.contentType + "; charset=utf-8", "Content-Length": String(entry.size), ...headers },
});
async function worker(nonce, extra = {}) {
  return (await import("data:text/javascript;base64," + Buffer.from(createAssetVerifierSource({ ...options(nonce), ...extra })).toString("base64"))).default;
}
const request = (nonce, path = entry.path, method = "GET", headers = {}) => new Request("https://ops-ui-verify-synthetic.example" + path, {
  method, headers: { Authorization: "Bearer " + nonce.bearer, ...headers },
});

test("generated temporary Worker serves only authenticated immutable allowlisted static bytes", async () => {
  const nonce = createAssetVerificationNonce(), input = options(nonce), before = structuredClone(input);
  assert.match(nonce.bearer, /^[A-Za-z0-9_-]{43}$/u); assert.equal(sha(nonce.bearer), nonce.nonceHash);
  const source = createAssetVerifierSource(input); assert(!source.includes(nonce.bearer)); assert.deepEqual(input, before);
  const app = await worker(nonce), calls = [];
  const env = { SOURCE_ASSETS: { fetch: async req => { calls.push(req); return response(req.method); } } };
  const result = await app.fetch(request(nonce, entry.path, "GET", { Cookie: "private-sentinel", "Cloudflare-Workers-Version-Overrides": "other=bad" }), env);
  assert.equal(result.status, 200); assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://ops.ledgetop.app" + entry.path);
  assert.equal(calls[0].headers.get("Cloudflare-Workers-Version-Overrides"), `ledgetop-ops="${versionId}"`);
  assert.equal(calls[0].headers.get("Cookie"), null); assert.equal(calls[0].headers.get("Authorization"), null);
  assert.equal(calls[0].redirect, "manual");
  const head = await app.fetch(request(nonce, entry.path, "HEAD"), env);
  assert.equal(head.status, 200); assert.equal(head.body, null);
});

test("forbidden business paths, unknown assets, methods, queries and wrong tokens never reach the source", async () => {
  const nonce = createAssetVerificationNonce(), app = await worker(nonce); let calls = 0;
  const env = { SOURCE_ASSETS: { fetch: async () => { calls++; return response("GET"); } } };
  for (const req of [request(nonce, "/api/session"), request(nonce, "/portal/account"), request(nonce, "/s/client"),
    request(nonce, "/assets/unknown.js"), request(nonce, entry.path + "?anything=1"), request(nonce, entry.path, "POST"),
    request({ bearer: "a".repeat(43) }), new Request("https://example.test" + entry.path)]) {
    assert.equal((await app.fetch(req, env)).status, 404);
  }
  assert.equal(calls, 0);
});

test('upstream length may be absent but actual GET bytes still require exact size and hash',async()=>{
 const nonce=createAssetVerificationNonce(),app=await worker(nonce);
 for(const method of ['GET','HEAD']){
  const result=await app.fetch(request(nonce,entry.path,method),{SOURCE_ASSETS:{fetch:async()=>new Response(method==='HEAD'?null:bytes,{headers:{'Content-Type':entry.contentType}})}});
  assert.equal(result.status,200);assert.equal(result.headers.get('Content-Length'),String(bytes.length));
  assert.deepEqual(Buffer.from(await result.arrayBuffer()),method==='HEAD'?Buffer.alloc(0):bytes);
 }
 const bad=await app.fetch(request(nonce),{SOURCE_ASSETS:{fetch:async()=>new Response(Buffer.from('wrong!'),{headers:{'Content-Type':entry.contentType}})}});
 assert.equal(bad.status,502);
});

test("source redirects, wrong MIME/size/hash and oversized streams fail closed without leaking headers", async () => {
  const nonce = createAssetVerificationNonce(), app = await worker(nonce);
  for (const source of [new Response(null, { status: 302, headers: { Location: "https://private-sentinel.example" } }),
    response("GET", bytes, { "Content-Type": "text/html" }), response("GET", bytes, { "Content-Length": "100" }),
    response("GET", Buffer.from("wrong!")), response("GET", Buffer.concat([bytes, bytes])),
    response("GET", bytes, { "Content-Encoding": "gzip" })]) {
    const result = await app.fetch(request(nonce), { SOURCE_ASSETS: { fetch: async () => source } });
    assert.equal(result.status, 502); assert.equal(await result.text(), ""); assert.equal(result.headers.get("Location"), null);
  }
});

test("target, version, manifest resource bounds and namespace restrictions are validated before source generation", () => {
  const input = options(createAssetVerificationNonce());
  for (const patch of [{ workerName: "ledgetop-ops-staging" }, { origin: "https://evil.example" }, { versionId: undefined },
    { versionId: "bad" }, { nonceHash: "bad" }, { entries: [entry, entry] }, { entries: [{ ...entry, path: "/api/private.js" }] },
    { entries: [{ ...entry, path: "/assets/../private.js" }] }, { entries: [{ ...entry, path: "/assets/%2fprivate.js" }] },
    { entries: [{ ...entry, size: 16 * 1024 * 1024 + 1 }] }, { entries: [{ ...entry, contentType: "text/html\nsecret" }] },
    { entries: [{ ...entry, extra: "private-sentinel" }] }]) {
    assert.throws(() => createAssetVerifierSource({ ...input, ...patch }), error => error.message === "static_asset_verification_refused");
  }
  assert.match(createAssetVerifierSource({ ...input, workerName: "ledgetop-clients", origin: "https://portal.ledgetop.app" }), /portal\.ledgetop\.app/u);
});

test('bounded 471-file Operations inventory of 152255343 bytes fits while inventories above 256 MiB fail before any fetch', async () => {
  const targetBytes = 152_255_343, count = 471, base = Math.floor(targetBytes / count), extra = targetBytes % count;
  const opsRows = Array.from({ length: count }, (_, i) => ({
    path: i === 0 ? '/index.html' : `/assets/ops-${String(i).padStart(3, '0')}.js`,
    size: base + (i < extra ? 1 : 0), sha256: String(i + 1).padStart(64, '0'),
    contentType: i === 0 ? 'text/html' : 'text/javascript',
  }));
  assert.equal(opsRows.reduce((sum, row) => sum + row.size, 0), targetBytes);
  assert.ok(targetBytes > 128 * 1024 * 1024 && targetBytes < ASSET_VERIFICATION_LIMITS.totalBytes);
  assert.doesNotThrow(() => createAssetVerifierSource({ ...options(createAssetVerificationNonce()), entries: opsRows }));

  const tooLarge = Array.from({ length: 1000 }, (_, i) => ({ ...entry,
    path: i === 0 ? '/index.html' : `/assets/large-${String(i).padStart(3, '0')}.js`,
    size: 269_000, sha256: String(i + 1).padStart(64, '0') }));
  assert.ok(tooLarge.reduce((sum, row) => sum + row.size, 0) > ASSET_VERIFICATION_LIMITS.totalBytes);
  let calls = 0;
  await assert.rejects(collectVerifiedAssets({ entries: tooLarge, fetchAsset: async () => { calls++; return response('GET'); } }));
  assert.equal(calls, 0, 'over-limit inventory is refused before helper calls');
});

test("collector checks HEAD and GET and returns byte-exact copies without input mutation", async () => {
  const entries = [entry], before = structuredClone(entries), methods = [];
  const assets = await collectVerifiedAssets({ entries, fetchAsset: async (row, { method }) => { assert.deepEqual(row, entry); methods.push(method); return response(method); } });
  assert.deepEqual(methods, ["HEAD", "GET"]); assert.deepEqual(assets.get(entry.path), bytes); assert.deepEqual(entries, before);
});

test("native verifier accepts only the pinned favicon MIME alias while retaining exact byte checks", async () => {
  assert.equal(faviconBytes.length, 1889);
  assert.equal(sha(faviconBytes), '4475e1abc388373b2e6c77b91e229e55e65b4efa1435e5aa816056873ad30e36');
  const nonce = createAssetVerificationNonce();
  for (const [contentType, upstreamType] of [['image/x-icon', 'image/vnd.microsoft.icon'],
    ['image/vnd.microsoft.icon', 'image/x-icon']]) {
    const icon = { path: '/favicon.ico', size: faviconBytes.length, sha256: sha(faviconBytes), contentType };
    const app = await worker(nonce, { entries: [icon] });
    const env = { SOURCE_ASSETS: { fetch: async req => new Response(req.method === 'HEAD' ? null : faviconBytes,
      { headers: { 'Content-Type': upstreamType, 'Content-Length': String(faviconBytes.length) } }) } };
    const result = await app.fetch(request(nonce, icon.path), env);
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), faviconBytes);
    const checked = await collectVerifiedAssets({ entries: [icon], fetchAsset: async (_row, { method }) =>
      new Response(method === 'HEAD' ? null : faviconBytes,
        { headers: { 'Content-Type': upstreamType, 'Content-Length': String(faviconBytes.length) } }) });
    assert.deepEqual(checked.get(icon.path), faviconBytes);
  }

  const wrongBytes = Buffer.from('wrong icon bytes');
  const legacyIcon = { path: '/favicon.ico', size: faviconBytes.length, sha256: sha(faviconBytes), contentType: 'image/x-icon' };
  const legacyApp = await worker(nonce, { entries: [legacyIcon] });
  const wrongBody = await legacyApp.fetch(request(nonce, legacyIcon.path), { SOURCE_ASSETS: { fetch: async () =>
    new Response(wrongBytes, { headers: { 'Content-Type': 'image/vnd.microsoft.icon' } }) } });
  assert.equal(wrongBody.status, 502);

  const otherPath = { ...legacyIcon, path: '/assets/favicon.ico' };
  const otherPathApp = await worker(nonce, { entries: [otherPath] });
  const wrongMime = await otherPathApp.fetch(request(nonce, otherPath.path), { SOURCE_ASSETS: { fetch: async () =>
    new Response(faviconBytes, { headers: { 'Content-Type': 'image/vnd.microsoft.icon' } }) } });
  assert.equal(wrongMime.status, 502);
});

test('collector accepts optional outer length while still verifying actual bytes and hash',async()=>{
 const fetchAsset=async(_entry,{method})=>new Response(method==='HEAD'?null:bytes,{headers:{'Content-Type':entry.contentType}});
 const result=await collectVerifiedAssets({entries:[entry],fetchAsset});assert.deepEqual(result.get(entry.path),bytes);
 await assert.rejects(collectVerifiedAssets({entries:[entry],fetchAsset:async(_entry,{method})=>new Response(method==='HEAD'?null:Buffer.from('wrong!'),{headers:{'Content-Type':entry.contentType}})}));
});

test("collector refuses incorrect HEAD or GET without retries or private diagnostics", async () => {
  for (const failing of ["HEAD", "GET"]) {
    let calls = 0;
    await assert.rejects(collectVerifiedAssets({ entries: [entry], fetchAsset: async (_row, { method }) => {
      calls++; if (method === failing) return response(method, bytes, { "Content-Type": "text/html" }); return response(method);
    } }), /static_asset_verification_refused/u);
    assert.equal(calls, failing === "HEAD" ? 1 : 2);
  }
  await assert.rejects(collectVerifiedAssets({ entries: [entry], fetchAsset: async () => { throw Error("private-sentinel"); } }), error => !error.message.includes("private-sentinel"));
});

test("lifecycle attempts one create and always deletes once plus independent absence read, including ambiguous create", async () => {
  for (const failure of [null, "create", "fetch", "remove", "absent"]) {
    const calls = [];
    const operation = executeAssetVerification({ entries: [entry],
      create: async () => { calls.push("create"); if (failure === "create") throw Error("private-sentinel"); },
      fetchAsset: async (_row, { method }) => { calls.push(method); if (failure === "fetch") throw Error(); return response(method); },
      remove: async () => { calls.push("remove"); if (failure === "remove") throw Error(); },
      readAbsent: async () => { calls.push("absent"); return failure !== "absent"; },
    });
    if (failure) await assert.rejects(operation, /static_asset_verification_refused/u);
    else { const value = await operation; assert.deepEqual(value.assets.get(entry.path), bytes); assert.equal(value.receipt.versionOverrideAppliedVerified, false); }
    assert.equal(calls.filter(x => x === "create").length, 1); assert.deepEqual(calls.slice(-2), ["remove", "absent"]);
  }
});

test("cancellation before creation does not delete an uncreated name; cancellation during reads still cleans up once", async () => {
  const early = new AbortController(); early.abort(); const calls = [];
  const base = { entries: [entry], create: async () => { calls.push("create"); }, remove: async () => { calls.push("remove"); }, readAbsent: async () => { calls.push("absent"); return true; }, fetchAsset: async (_row, { method }) => response(method) };
  await assert.rejects(executeAssetVerification({ ...base, signal: early.signal }), /static_asset_verification_refused/u); assert.deepEqual(calls, []);
  const active = new AbortController();
  await assert.rejects(executeAssetVerification({ ...base, signal: active.signal, fetchAsset: async (_row, { method }) => { active.abort(); return response(method); } }), /static_asset_verification_refused/u);
  assert.deepEqual(calls, ["create", "remove", "absent"]);
});

test("cancellation interrupts a stalled body read and cancels the reader before cleanup", async () => {
  const controller = new AbortController(), calls = []; let cancelCount = 0;
  const stalled = new ReadableStream({ pull() { setTimeout(() => controller.abort(), 0); }, cancel() { cancelCount++; } });
  await assert.rejects(executeAssetVerification({ entries: [entry], signal: controller.signal,
    create: async () => { calls.push("create"); },
    fetchAsset: async (_row, { method }) => method === "HEAD" ? response(method) : response(method, stalled),
    remove: async () => { calls.push("remove"); }, readAbsent: async () => { calls.push("absent"); return true; },
  }), /static_asset_verification_refused/u);
  assert.equal(cancelCount, 1); assert.deepEqual(calls, ["create", "remove", "absent"]);
});

test("fixed app index transports preserve manifest paths and never follow an entry redirect", async () => {
  const nonce=createAssetVerificationNonce(), index={...entry,path:'/index.html',contentType:'text/html'};
  for(const [workerName,origin,transport] of [['ledgetop-ops','https://ops.ledgetop.app','/'],['ledgetop-clients','https://portal.ledgetop.app','/portal']]) {
    const app=await worker(nonce,{workerName,origin,entries:[index]}),calls=[];
    const env={SOURCE_ASSETS:{fetch:async req=>{calls.push(req);return new Response(bytes,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Length':String(bytes.length),'X-Verified-Version':'untrusted-marker'}});}}};
    const result=await app.fetch(request(nonce,index.path),env);
    assert.equal(result.status,200);assert.equal(calls[0].url,origin+transport);assert.equal(calls[0].redirect,'manual');
    assert.equal(result.headers.get('X-Verified-Version'),null);assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes);
    const redirect=await app.fetch(request(nonce,index.path),{SOURCE_ASSETS:{fetch:async()=>new Response(null,{status:307,headers:{Location:origin+transport}})}});
    assert.equal(redirect.status,502);assert.equal(redirect.headers.get('Location'),null);
    assert.equal((await app.fetch(request(nonce,transport),env)).status,404);
  }
});
test("known app and SHA prefixed historical assets are checked at the exact original path",async()=>{
  const nonce=createAssetVerificationNonce();
  for(const appName of ['operations','client']) {
    const prefixed={...entry,path:`/_ui/${appName}/${'a'.repeat(40)}/assets/old-build.js`};
    const app=await worker(nonce,{entries:[prefixed]}),calls=[];
    assert.equal((await app.fetch(request(nonce,prefixed.path),{SOURCE_ASSETS:{fetch:async req=>{calls.push(req.url);return response(req.method);}}})).status,200);
    assert.deepEqual(calls,['https://ops.ledgetop.app'+prefixed.path]);
  }
  for(const p of [`/_ui/other/${'a'.repeat(40)}/assets/old.js`,`/_ui/client/${'a'.repeat(39)}/assets/old.js`,`/_ui/client/${'A'.repeat(40)}/assets/old.js`,`/_ui/client/${'a'.repeat(40)}/api/private.js`])
    assert.throws(()=>createAssetVerifierSource({...options(nonce),entries:[{...entry,path:p}]}),/static_asset_verification_refused/);
});

test('root HTML archive keeps its physical manifest key and fetches only the fixed directory transport for GET and HEAD',async()=>{
  const nonce=createAssetVerificationNonce(),oldHtml=Buffer.from('<html>previous release</html>'),sha256=sha(oldHtml);
  const archived={path:`/_ui/operations/${sha256.slice(0,40)}/index.html`,size:oldHtml.length,sha256,contentType:'text/html'};
  const app=await worker(nonce,{entries:[archived]}),calls=[];
  const env={SOURCE_ASSETS:{fetch:async req=>{calls.push(req);return new Response(req.method==='HEAD'?null:oldHtml,
    {headers:{'Content-Type':'text/html; charset=utf-8','Content-Length':String(oldHtml.length)}});}}};
  for(const method of ['HEAD','GET']) {
    const result=await app.fetch(request(nonce,archived.path,method),env);
    assert.equal(result.status,200);
    if(method==='HEAD')assert.equal(result.body,null);else assert.deepEqual(Buffer.from(await result.arrayBuffer()),oldHtml);
  }
  assert.deepEqual(calls.map(req=>req.url),[`https://ops.ledgetop.app/_ui/operations/${sha256.slice(0,40)}/`,
    `https://ops.ledgetop.app/_ui/operations/${sha256.slice(0,40)}/`]);
  assert.ok(calls.every(req=>req.redirect==='manual'&&!req.headers.has('Cookie')&&!req.headers.has('Authorization')));
  for(const p of [`/_ui/client/${sha256.slice(0,40)}/index.html`,`/_ui/operations/${sha256.slice(0,39)}/index.html`,
    `/_ui/operations/${sha256.slice(0,40)}/index.html/extra`])
    assert.throws(()=>createAssetVerifierSource({...options(nonce),entries:[{...archived,path:p}]}),/static_asset_verification_refused/);
  assert.throws(()=>createAssetVerifierSource({...options(nonce),workerName:'ledgetop-clients',origin:'https://portal.ledgetop.app',entries:[archived]}),
    /static_asset_verification_refused/);
});

test('source release proof is routed only through the exact candidate override as immutable JSON',async()=>{
  const nonce=createAssetVerificationNonce(),sourceCommit='b'.repeat(40),proofBytes=Buffer.from(JSON.stringify({
    schemaVersion:1,workerName:'ledgetop-ops',sourceCommit,parentVersionId:versionId})+'\n');
  const proof={path:`/_ui/operations/${sourceCommit}/release.json`,size:proofBytes.length,sha256:sha(proofBytes),contentType:'application/json'};
  const app=await worker(nonce,{entries:[proof]}),calls=[];
  const env={SOURCE_ASSETS:{fetch:async req=>{calls.push(req);return new Response(req.method==='HEAD'?null:proofBytes,
    {headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':String(proofBytes.length)}});}}};
  for(const method of ['HEAD','GET']){
    const result=await app.fetch(request(nonce,proof.path,method),env);
    assert.equal(result.status,200);
    if(method==='GET')assert.deepEqual(Buffer.from(await result.arrayBuffer()),proofBytes);
    else assert.equal(result.body,null);
  }
  assert.deepEqual(calls.map(req=>req.url),Array(2).fill(`https://ops.ledgetop.app${proof.path}`));
  assert.ok(calls.every(req=>req.headers.get('Cloudflare-Workers-Version-Overrides')===`ledgetop-ops="${versionId}"`));
  assert.throws(()=>createAssetVerifierSource({...options(nonce),entries:[{...proof,path:`/_ui/client/${sourceCommit}/release.json`}]}),
    /static_asset_verification_refused/);
  assert.throws(()=>createAssetVerifierSource({...options(nonce),entries:[{...proof,contentType:'text/html'}]}),
    /static_asset_verification_refused/);
});

test('collector deadline bounds an uncooperative HEAD or GET and sends no request after expiry',async()=>{
  for(const stalledMethod of ['HEAD','GET']) {
    const calls=[];let release,passedSignal;
    const pending=new Promise(resolve=>{release=resolve;});
    await assert.rejects(collectVerifiedAssets({entries:[entry],timeoutMs:10,fetchAsset:async(_row,{method,signal})=>{
      calls.push(method);passedSignal=signal;return method===stalledMethod?pending:response(method);
    }}),/static_asset_verification_refused/);
    assert.equal(passedSignal.aborted,true);assert.deepEqual(calls,stalledMethod==='HEAD'?['HEAD']:['HEAD','GET']);
    release(response(stalledMethod));await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(calls,stalledMethod==='HEAD'?['HEAD']:['HEAD','GET']);
  }
});
test('body deadline ignores a nonsettling cancellation and cleanup still executes once',async()=>{
  const calls=[];let cancels=0,readSignal;
  const stalled=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancels++;return new Promise(()=>{});}});
  await assert.rejects(executeAssetVerification({entries:[entry],timeoutMs:10,
    create:async()=>{calls.push('create');},
    fetchAsset:async(_row,{method,signal})=>{readSignal=signal;calls.push(method);return method==='HEAD'?response(method):response(method,stalled);},
    remove:async()=>{calls.push('remove');},readAbsent:async()=>{calls.push('absent');return true;}
  }),/static_asset_verification_refused/);
  assert.equal(readSignal.aborted,true);assert.equal(cancels,1);assert.deepEqual(calls,['create','HEAD','GET','remove','absent']);
});
test('caller abort bounds an uncooperative fetch without waiting for the longer deadline',async()=>{
  const controller=new AbortController();let passedSignal;
  const operation=collectVerifiedAssets({entries:[entry],signal:controller.signal,timeoutMs:300_000,
    fetchAsset:async(_row,{signal})=>{passedSignal=signal;return new Promise(()=>{});}});
  controller.abort();await assert.rejects(operation,/static_asset_verification_refused/);assert.equal(passedSignal.aborted,true);
});
test('invalid collector timeouts refuse before verifier creation or network',async()=>{
  for(const timeoutMs of[0,-1,1.5,300001,Infinity,'10',null]) {
    let calls=0;await assert.rejects(executeAssetVerification({entries:[entry],timeoutMs,
      create:async()=>{calls++;},fetchAsset:async()=>{calls++;},remove:async()=>{calls++;},readAbsent:async()=>{calls++;}}),/static_asset_verification_refused/);
    assert.equal(calls,0);
  }
});
