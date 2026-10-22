import test from 'node:test';
import assert from 'node:assert/strict';
import {writeArrayBuffer} from 'geotiff';
import {preflightBrowserRasterHeader} from '../measurement-raster-header.mjs';

test('real TIFF header preflight fetches bounded ranges, not pixel data or the whole file',async()=>{
  const bytes=new Uint8Array(writeArrayBuffer(new Uint8Array(64),{width:8,height:8})),requests=[];
  await preflightBrowserRasterHeader('/test.tif',{fetcher:async(_url,options)=>{
    const [,a,b]=/bytes=(\d+)-(\d+)/.exec(options.headers.Range),start=Number(a),end=Number(b);requests.push(end-start+1);
    return new Response(bytes.slice(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`}});
  }});
  assert.equal(requests.length,3);assert.ok(requests.every(n=>n<=8192));
});

test('ignoring Range and lying about body size cannot buffer the whole raster',async()=>{
  await assert.rejects(preflightBrowserRasterHeader('/test.tif',{fetcher:async()=>new Response(new Uint8Array(32),{status:200})}),/safe byte ranges/);
  await assert.rejects(preflightBrowserRasterHeader('/test.tif',{fetcher:async()=>new Response(new Uint8Array(32),{status:206,headers:{'content-range':'bytes 0-15/1000','content-length':'16'}})}),/safe byte ranges/);
});

test('cancellation is passed through before metadata parsing',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(preflightBrowserRasterHeader('/test.tif',{signal:controller.signal,fetcher:async(_url,{signal})=>{signal.throwIfAborted();}}),{name:'AbortError'});
});
