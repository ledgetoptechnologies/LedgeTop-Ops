/** Native workerd Request + service-binding contract for the generated verifier.
 * Synthetic static bytes only; no Cloudflare account, auth, assets inventory,
 * candidate routing, workers.dev lifecycle or production qualification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createAssetVerificationNonce, createAssetVerifierSource } from './production-auto-verify.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const requireLocked=createRequire(path.join(root,'apps/operations/node_modules','__verifier-fixture.cjs'));
const {Miniflare}=requireLocked('miniflare');
const bytes=Buffer.from([0,255,13,10,65,0]),digest=createHash('sha256').update(bytes).digest('hex');
const versionId='00000000-0000-4000-8000-000000000001';
const entries=['/assets/good.js','/assets/no-length.js','/assets/wrong-length.js','/assets/redirect.js','/index.html'].map(p=>({path:p,size:bytes.length,sha256:digest,
  contentType:p==='/index.html'?'text/html':'text/javascript'}));

test('native generated verifier uses manual redirects for GET/HEAD and forwards no caller credentials',async t=>{
  const nonce=createAssetVerificationNonce();
  const generated=createAssetVerifierSource({workerName:'ledgetop-clients',origin:'https://portal.ledgetop.app',entries,nonceHash:nonce.nonceHash,versionId});
  const source=`export default {fetch(request){
    const url=new URL(request.url);
    if(url.pathname==='/native-request-contract'){
      try{new Request('https://constructor.invalid/',{redirect:'error'});return new Response('unexpected');}
      catch(error){return new Response(error instanceof TypeError?'TypeError':'unexpected');}
    }
    const forbidden=['cookie','authorization','cf-access-jwt-assertion','referer','x-private-probe'];
    if(url.origin!=='https://portal.ledgetop.app'||url.search||request.redirect!=='manual'||forbidden.some(n=>request.headers.has(n)))return new Response(null,{status:500});
    if(request.headers.get('Cloudflare-Workers-Version-Overrides')!==${JSON.stringify(`ledgetop-clients="${versionId}"`)})return new Response(null,{status:500});
    if(url.pathname==='/assets/redirect.js')return new Response(null,{status:307,headers:{Location:'https://redirect.invalid/private'}});
    if(url.pathname==='/assets/no-length.js'){
      const body=request.method==='HEAD'?null:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(${JSON.stringify([...bytes])}));controller.close();}});
      return new Response(body,{headers:{'Content-Type':'text/javascript'}});
    }
    if(url.pathname==='/assets/wrong-length.js')return new Response(request.method==='HEAD'?null:new Uint8Array(${JSON.stringify([...bytes,99])}),{headers:{'Content-Type':'text/javascript','Content-Length':'7'}});
    if(!['/assets/good.js','/portal'].includes(url.pathname))return new Response(null,{status:404});
    return new Response(request.method==='HEAD'?null:new Uint8Array(${JSON.stringify([...bytes])}),{headers:{'Content-Type':url.pathname==='/portal'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','Content-Length':'6','Set-Cookie':'private-sentinel=blocked','X-Verified-Version':'unproven'}});
  }};`;
  const runtime=new Miniflare({workers:[
    {name:'verifier',modules:true,script:generated,compatibilityDate:'2026-07-22',serviceBindings:{SOURCE_ASSETS:'synthetic-static-source'}},
    {name:'synthetic-static-source',modules:true,script:source,compatibilityDate:'2026-07-22'},
  ]});
  t.after(()=>runtime.dispose());const endpoint=await runtime.ready;
  const nativeSource=await runtime.getWorker('synthetic-static-source');
  const nativeContract=await nativeSource.fetch('https://fixture.invalid/native-request-contract');
  assert.equal(await nativeContract.text(),'TypeError'); // Node's Request accepts this; native Workers must reject it.
  const headers={Authorization:'Bearer '+nonce.bearer,'Accept-Encoding':'identity',Cookie:'caller=private','Cf-Access-Jwt-Assertion':'private-sentinel',Referer:'https://private.invalid/?token=sentinel','X-Private-Probe':'private-sentinel'};
  // The helper's length is the reviewed manifest pin. Only GET byte-count and
  // SHA verification establish content equality; no source length is claimed.
  for(const asset of ['/assets/good.js','/assets/no-length.js','/index.html'])for(const method of ['GET','HEAD']){
    const response=await fetch(new URL(asset,endpoint),{method,headers});
    assert.equal(response.status,200,`${method} ${asset}: ${response.headers.get('X-Ops-Static-Check')??'no-stage'}`);
    assert.equal(response.headers.get('Content-Length'),'6',`${method} ${asset} length`);assert.equal(response.headers.get('Set-Cookie'),null);
    assert.equal(response.headers.get('X-Verified-Version'),null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),method==='HEAD'?Buffer.alloc(0):bytes);
  }
  for(const method of ['GET','HEAD']){
    const response=await fetch(new URL('/assets/wrong-length.js',endpoint),{method,headers});
    assert.equal(response.status,502);assert.equal(response.headers.get('X-Ops-Static-Check'),'upstream-length');
    assert.equal(await response.text(),'');
  }
  for(const method of ['GET','HEAD']){
    const response=await fetch(new URL('/assets/redirect.js',endpoint),{method,headers});
    assert.equal(response.status,502);assert.equal(response.headers.get('Location'),null);
    assert.equal(await response.text(),'');
  }
  const denied=await fetch(new URL('/assets/good.js',endpoint));assert.equal(denied.status,404);
});
