import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sessionProductsUrl,safeProductTicket,mountViewerProductDownloads} from '../viewer-product-downloads.mjs';

test('product endpoint is derived only from known same-origin scoped asset URLs',()=>{
  const origin='https://viewer.test';
  assert.equal(sessionProductsUrl('/session-assets/token/model/models/a.glb',origin),'/session-products/token/model');
  assert.equal(sessionProductsUrl('https://viewer.test/session-assets/share.signature/model/webodm/a.tif',origin),'/session-products/share.signature/model');
  assert.equal(sessionProductsUrl('https://evil.test/session-assets/token/model/models/a.glb',origin),null);
  assert.equal(sessionProductsUrl('/assets/model/models/a.glb',origin),null);
  assert.equal(sessionProductsUrl('',origin),null);
});
test('download navigation accepts only narrow opaque same-origin product tickets',()=>{
  const origin='https://viewer.test',token='a'.repeat(43),path=`/session-product-downloads/${token}`;
  assert.equal(safeProductTicket(path,origin),origin+path);
  for(const bad of ['https://evil.test'+path,path+'?token=broad',path+'#secret','javascript:alert(1)','/session-assets/broad/model/file',path+'/child'])assert.equal(safeProductTicket(bad,origin),null);
});
test('viewer products keep sources out of browser heaps and recheck permission before download',()=>{
  const source=readFileSync(new URL('../viewer-product-downloads.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\.blob\(|createObjectURL|innerHTML\s*=/);
  assert.match(source,/!allowed\(\).*epoch !== generation/);
  assert.match(source,/link\.referrerPolicy = 'no-referrer'/);
  assert.match(source,/controller\?\.abort\(\)/);
});

function reportFixture(fetchRef) {
  const clicked=[];
  class Element {
    constructor(tag) { this.tag=tag; this.children=[]; this.open=false; }
    append(...children) { this.children.push(...children); }
    setAttribute() {} addEventListener() {} remove() {} focus() {}
    replaceChildren(...children) { this.children=children; }
    close() { this.open=false; } showModal() { this.open=true; }
    click() { clicked.push(this); }
  }
  const documentRef={createElement:tag=>new Element(tag),body:new Element('body'),head:new Element('head')};
  const host=new Element('div'),reportHost=new Element('div');
  let allowed=true,assetRoot='/session-assets/token/model/models/a.glb';
  const mounted=mountViewerProductDownloads({host,reportHost,getAssetRoot:()=>assetRoot,permitted:()=>allowed,documentRef,fetchRef,origin:'https://viewer.test'});
  const container=reportHost.children[0],[button,status]=container.children;
  return {mounted,button,status,container,clicked,deny(){allowed=false;mounted.refresh();},change(){assetRoot='/session-assets/token/other/models/b.glb';mounted.refresh();}};
}

test('separate model report button downloads only the registered original report ticket',async()=>{
  const calls=[],ticket='/session-product-downloads/'+'a'.repeat(43);
  const fixture=reportFixture(async(url,options)=>{
    calls.push([url,options.method]);
    return {ok:true,json:async()=>options.method==='POST'?{url:ticket,fileName:'report.pdf'}:{products:[{kind:'report',grantUrl:'/session-products/token/model/report/download-grants'}]}};
  });
  await fixture.button.onclick();
  assert.deepEqual(calls,[['/session-products/token/model',undefined],['/session-products/token/model/report/download-grants','POST']]);
  assert.equal(fixture.clicked[0].href,'https://viewer.test'+ticket);
  assert.equal(fixture.clicked[0].download,'report.pdf');
  assert.match(fixture.status.textContent,/Original report download started/);
  fixture.deny();assert.equal(fixture.container.hidden,true);
  await fixture.button.onclick();assert.equal(calls.length,2);
  fixture.mounted.destroy();
});

test('missing original report explains availability without creating a substitute PDF',async()=>{
  let calls=0;
  const fixture=reportFixture(async()=>{calls++;return {ok:true,json:async()=>({products:[]})};});
  await fixture.button.onclick();
  assert.match(fixture.status.textContent,/No original processing and quality report/);
  assert.equal(calls,1);assert.equal(fixture.clicked.length,0);assert.equal(fixture.button.disabled,false);
  fixture.mounted.destroy();
});

test('model change during report lookup cannot start a download for the prior model',async()=>{
  let resolve;
  const fixture=reportFixture(()=>new Promise(done=>{resolve=done;}));
  const pending=fixture.button.onclick();fixture.change();
  resolve({ok:true,json:async()=>({products:[{kind:'report',grantUrl:'/session-products/token/model/report/download-grants'}]})});
  await pending;assert.equal(fixture.clicked.length,0);assert.equal(fixture.status.textContent,'');
  assert.equal(fixture.button.disabled,false);fixture.mounted.destroy();
});
