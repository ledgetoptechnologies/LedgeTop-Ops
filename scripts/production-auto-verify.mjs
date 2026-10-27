import { createHash, randomBytes } from "node:crypto";

// Temporary static-byte verification only. Provider creation/deletion, exact
// service-binding readback, and before/after production snapshots belong to the
// caller. A version override is not evidence that Cloudflare applied it:
// https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/
const TARGETS = { "ledgetop-ops": "https://ops.ledgetop.app", "ledgetop-clients": "https://portal.ledgetop.app" };
const HASH = /^[a-f0-9]{64}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_FILE = 16 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024;
const fail = () => { throw Error("static_asset_verification_refused"); };
const need = value => { if (!value) fail(); };
const digest = value => createHash("sha256").update(value).digest("hex");
const mime = value => typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
function manifest(entries) {
  need(Array.isArray(entries) && entries.length > 0 && entries.length <= 1024);
  const paths = new Set(); let total = 0;
  return entries.map(entry => {
    need(entry && Object.getPrototypeOf(entry) === Object.prototype && Object.keys(entry).sort().join() === "contentType,path,sha256,size");
    const { path, size, sha256, contentType } = entry;
    need(typeof path === "string" && path.length <= 1024 && /^\/(?:assets\/[A-Za-z0-9_./-]+|_ui\/(?:operations|client)\/[a-f0-9]{40}\/assets\/[A-Za-z0-9_./-]+|_ui\/[A-Za-z0-9_-]+\/assets\/[A-Za-z0-9_./-]+|[A-Za-z0-9_-]+\.(?:html|js|mjs|css|json|webmanifest|ico|png|svg|webp|txt))$/u.test(path));
    need(!path.includes("..") && !path.includes("//") && !path.split("/").includes(".") && !paths.has(path));
    need(Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE && HASH.test(sha256));
    need(typeof contentType === "string" && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType));
    total += size; need(total <= MAX_TOTAL); paths.add(path);
    return { path, size, sha256, contentType };
  });
}
export function createAssetVerificationNonce() {
  const bearer = randomBytes(32).toString("base64url");
  return { bearer, nonceHash: digest(bearer) };
}

/** Pure module source. Bind SOURCE_ASSETS to precisely workerName; no other
 * bindings, routes, secrets, data stores, or RPC entrypoints are needed.
 * versionId must independently be fenced in the current deployment; the header
 * can silently fall back, so returned byte equality alone does not pin a version.
 * The caller may expose only this temporary Worker on its workers.dev endpoint.
 * It must delete it once and verify absence, including after failed reads. */
export function createAssetVerifierSource({ workerName, origin, entries, nonceHash, versionId }) {
  need(Object.hasOwn(TARGETS, workerName) && TARGETS[workerName] === origin && HASH.test(nonceHash));
  need(typeof versionId === "string" && UUID.test(versionId));
  const rows = manifest(entries);
  // These are fixed known app entry transports, not redirect destinations.
  // The manifest key remains /index.html. Every response still must be 200.
  const indexTransportPath = workerName === "ledgetop-clients" ? "/portal" : "/";
  const override = `${workerName}="${versionId}"`;
  return `const entries=new Map(${JSON.stringify(rows)}.map(x=>[x.path,x]));
const origin=${JSON.stringify(origin)}, nonceHash=${JSON.stringify(nonceHash)}, override=${JSON.stringify(override)}, indexTransportPath=${JSON.stringify(indexTransportPath)};
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const deny=(status,stage='',upstreamStatus=0)=>new Response(null,{status,headers:{'Cache-Control':'no-store',...(stage?{'X-Ops-Static-Check':stage}:{}),...(upstreamStatus?{'X-Ops-Upstream-Status':String(upstreamStatus)}:{})}});
export default {async fetch(request,env){
try{
 const url=new URL(request.url),auth=request.headers.get('Authorization')||'';
 if(!['GET','HEAD'].includes(request.method)||url.search||url.hash||url.pathname.includes('%'))return deny(404);
 const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth)?.[1];
 if(!token||hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))!==nonceHash)return deny(404);
 const entry=entries.get(url.pathname);if(!entry)return deny(404);
 const headers=new Headers({'Accept':entry.contentType,'Accept-Encoding':'identity'});
 if(override)headers.set('Cloudflare-Workers-Version-Overrides',override);
 const sourcePath=entry.path==='/index.html'?indexTransportPath:entry.path;
 // Workers rejects redirect:'error' at Request construction. Manual mode
 // returns redirects without following them; the strict200 check below holds.
 const response=await env.SOURCE_ASSETS.fetch(new Request(origin+sourcePath,{method:request.method,headers,redirect:'manual',signal:request.signal}));
 if(response.status!==200)return deny(502,'upstream-status',response.status);
 if(response.redirected||response.headers.has('Location')||response.headers.has('Content-Range')||response.headers.get('Content-Encoding'))return deny(502,'upstream-transfer',response.status);
 if((response.headers.get('Content-Type')||'').split(';',1)[0].trim().toLowerCase()!==entry.contentType)return deny(502,'upstream-mime',response.status);
 // Content-Length is optional on native asset/service responses. A declared
 // mismatch is rejected; GET still verifies every byte, length and SHA below.
 const declaredLength=response.headers.get('Content-Length');
 if(declaredLength!==null&&declaredLength!==String(entry.size))return deny(502,'upstream-length',response.status);
 const out={'Content-Type':entry.contentType,'Content-Length':String(entry.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(request.method==='HEAD')return new Response(null,{status:200,headers:out});
 const reader=response.body?.getReader();if(!reader&&entry.size!==0)return deny(502);
 const chunks=[];let length=0;if(reader){try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>entry.size){await reader.cancel();return deny(502);}chunks.push(part.value);}}finally{reader.releaseLock();}}
 if(length!==entry.size)return deny(502);const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 if(hex(await crypto.subtle.digest('SHA-256',bytes))!==entry.sha256)return deny(502);
 return new Response(bytes,{status:200,headers:out});
}catch{return deny(502,'upstream-exception');}}};\n`;
}

function responseMetadata(response, entry) {
  need(response instanceof Response && response.status === 200 && !response.redirected
    && !response.headers.has("Location") && !response.headers.has("Content-Range") && !response.headers.get("Content-Encoding")
    && mime(response.headers.get("Content-Type")) === entry.contentType
    && (response.headers.get("Content-Length") === null || response.headers.get("Content-Length") === String(entry.size)));
}
function notCancelled(signal) { if (signal?.aborted) fail(); }
/** fetchAsset(entry,{method,signal}) is injected and must address the temporary
 * verifier. Never pass a caller URL or arbitrary request headers through it.
 * The deadline covers the entire batch, including HEAD/GET and body reads;
 * a provider ignoring abort or cancellation cannot extend the caller's wait. */
export async function collectVerifiedAssets({ entries, fetchAsset, signal, timeoutMs = 120_000 }) {
  const rows = manifest(entries); need(typeof fetchAsset === "function"
    && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000);
  notCancelled(signal);
  const result = new Map(), controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let reader, timer, rejectDeadline;
  const cancelReader = () => { try { void reader?.cancel().catch(() => {}); } catch {} };
  const stop = () => { controller.abort(); cancelReader(); rejectDeadline(Error("static_asset_verification_refused")); };
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; timer = setTimeout(stop, timeoutMs); });
  signal?.addEventListener("abort", stop, { once: true });
  const operation = (async () => { try {
    for (const entry of rows) {
      notCancelled(combined);
      const head = await fetchAsset({ ...entry }, { method: "HEAD", signal: combined }); notCancelled(combined);
      responseMetadata(head, entry); need(head.body === null);
      const response = await fetchAsset({ ...entry }, { method: "GET", signal: combined }); notCancelled(combined);
      responseMetadata(response, entry);
      reader = response.body?.getReader(); need(reader || entry.size === 0);
      const chunks = []; let size = 0;
      if (reader) try {
        for (;;) {
          notCancelled(combined); const value = await reader.read(); notCancelled(combined);
          if (value.done) break;
          size += value.value.byteLength;
          if (size > entry.size) { cancelReader(); fail(); }
          chunks.push(Buffer.from(value.value));
        }
      } catch { cancelReader(); fail(); }
      finally { try { reader.releaseLock(); } catch {} reader = undefined; }
      const bytes = Buffer.concat(chunks, size);
      need(size === entry.size && digest(bytes) === entry.sha256); result.set(entry.path, bytes);
    }
    return result;
  } catch { fail(); } })();
  try { return await Promise.race([operation, deadline]); }
  catch { controller.abort(); cancelReader(); fail(); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
}

/** No provider API implementation or retry. remove must delete only the exact
 * newly-owned temporary name, and readAbsent must independently confirm 404.
 * A create exception may be ambiguous, so cleanup still runs exactly once.
 * Caller-owned before/after production snapshots remain mandatory. */
export async function executeAssetVerification({ create, fetchAsset, remove, readAbsent, entries, signal, timeoutMs = 120_000 }) {
  manifest(entries); for (const fn of [create, fetchAsset, remove, readAbsent]) need(typeof fn === "function");
  need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000);
  let assets, failure = false, removed = false, absent = false, createAttempted = false;
  try { notCancelled(signal); createAttempted = true; await create(); assets = await collectVerifiedAssets({ entries, fetchAsset, signal, timeoutMs }); }
  catch { failure = true; }
  finally {
    if (createAttempted) {
      try { await remove(); removed = true; } catch { failure = true; }
      try { absent = await readAbsent() === true; } catch { failure = true; }
    }
  }
  need(!failure && removed && absent);
  return { assets, receipt: { staticBytesVerified: true, temporaryWorkerRemoved: true, absenceVerified: true,
    versionOverrideAppliedVerified: false, productionUnchangedVerified: false, automaticRetry: false } };
}
