import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAssetVerificationNonce, createAssetVerifierSource, collectVerifiedAssets, executeAssetVerification } from "./production-auto-verify.mjs";

const bytes = Buffer.from([0, 255, 13, 10, 65, 0]);
const sha = value => createHash("sha256").update(value).digest("hex");
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

test("collector checks HEAD and GET and returns byte-exact copies without input mutation", async () => {
  const entries = [entry], before = structuredClone(entries), methods = [];
  const assets = await collectVerifiedAssets({ entries, fetchAsset: async (row, { method }) => { assert.deepEqual(row, entry); methods.push(method); return response(method); } });
  assert.deepEqual(methods, ["HEAD", "GET"]); assert.deepEqual(assets.get(entry.path), bytes); assert.deepEqual(entries, before);
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
