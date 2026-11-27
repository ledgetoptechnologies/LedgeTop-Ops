import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sessionProductsUrl,safeProductTicket,mountViewerProductDownloads,reportPermitted} from '../viewer-product-downloads.mjs';

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
  assert.equal(fixture.status.textContent,'');
  fixture.deny();assert.equal(fixture.container.hidden,true);
  await fixture.button.onclick();assert.equal(calls.length,2);
  fixture.mounted.destroy();
});

test('missing original report explains availability without creating a substitute PDF',async()=>{
  let calls=0;
  const fixture=reportFixture(async()=>{calls++;return {ok:true,json:async()=>({products:[]})};});
  await fixture.button.onclick();
  assert.match(fixture.status.textContent,/No model report for this version/);
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

// The Download dialog's list and download, through the same fixture.
const productsResponse = { products: [
  { kind: 'ortho', label: 'Orthophoto', format: 'TIF', byteSize: 3 * 1024 ** 3, grantUrl: '/session-products/token/model/ortho/download-grants' },
  { kind: 'dsm', label: 'Surface model (DSM)', format: 'TIF', byteSize: 1024, grantUrl: 'https://elsewhere.test/grant' },
  { kind: 'report', label: 'Model report', format: 'PDF', byteSize: 10, grantUrl: '/session-products/token/model/report/download-grants' },
] };
function productFixture() {
  const calls = [], ticket = '/session-product-downloads/' + 'b'.repeat(43);
  const fixture = reportFixture(async (url, options = {}) => {
    calls.push([url, options.method]);
    return { ok: true, json: async () => (options.method === 'POST' ? { url: ticket, fileName: 'orthophoto.tif' } : productsResponse) };
  });
  return { ...fixture, calls, ticket };
}

test('the list offers only registered same-scope products, without the report that has its own button', async () => {
  const f = productFixture();
  const items = await f.mounted.list();
  assert.deepEqual(items.map(item => [item.kind, item.label, item.format, item.size]), [['ortho', 'Orthophoto', 'TIF', '3.0 GiB']]);
  assert.equal(f.mounted.available(), true);
  f.mounted.destroy();
});

test('a product download hands one ticket to the browser, and nothing once access or the model changed', async () => {
  const f = productFixture();
  const [ortho] = await f.mounted.list();
  await f.mounted.download(ortho);
  assert.equal(f.clicked.length, 1);
  assert.equal(f.clicked[0].href, 'https://viewer.test' + f.ticket);
  assert.equal(f.clicked[0].referrerPolicy, 'no-referrer');
  f.change();
  await assert.rejects(f.mounted.download(ortho), /Reopen Download/);
  assert.equal(f.clicked.length, 1, 'no ticket for the previous model');
  const g = productFixture();
  const [again] = await g.mounted.list();
  g.deny();
  await assert.rejects(g.mounted.download(again));
  assert.equal(g.clicked.length, 0, 'no ticket once download permission is gone');
  assert.equal(g.mounted.available(), false);
  f.mounted.destroy(); g.mounted.destroy();
});

test('the model report button follows its own permission, apart from other downloads',async()=>{
  assert.equal(reportPermitted({download:true}),true,'an older link or session: the report came with downloads');
  assert.equal(reportPermitted({download:true,report:false}),false);
  assert.equal(reportPermitted({download:false,report:true}),true);
  assert.equal(reportPermitted({download:true,report:'true'}),false);
  assert.equal(reportPermitted(null),false);
  const calls=[];
  class Element {
    constructor(tag) { this.tag=tag; this.children=[]; }
    append(...children) { this.children.push(...children); }
    setAttribute() {} addEventListener() {} remove() {} focus() {} click() {}
  }
  const documentRef={createElement:tag=>new Element(tag),body:new Element('body'),head:new Element('head')};
  let download=true,report=false;
  const reportHost=new Element('div');
  const mounted=mountViewerProductDownloads({reportHost,getAssetRoot:()=>'/session-assets/token/model/models/a.glb',permitted:()=>download,reportPermitted:()=>report,documentRef,
    fetchRef:async url=>{calls.push(url);return {ok:true,json:async()=>({products:[]})};},origin:'https://viewer.test'});
  const reportBox=reportHost.children[0],[reportButton]=reportBox.children;
  assert.equal(mounted.available(),true);assert.equal(reportBox.hidden,true);
  await reportButton.onclick();assert.deepEqual(calls,[],'a hidden report button does nothing');
  download=false;report=true;mounted.refresh();
  assert.equal(mounted.available(),false);assert.equal(reportBox.hidden,false);
  await reportButton.onclick();assert.deepEqual(calls,['/session-products/token/model']);
  mounted.destroy();
});

test('a session renewal (refresh with nothing changed) leaves a products list loading and a report download running',async()=>{
  class Element {
    constructor(tag) { this.tag=tag; this.children=[]; }
    append(...children) { this.children.push(...children); } setAttribute() {} addEventListener() {} remove() {} focus() {} click() {}
  }
  const documentRef={createElement:tag=>new Element(tag),body:new Element('body'),head:new Element('head')};
  let resolveList;
  const mounted=mountViewerProductDownloads({reportHost:new Element('div'),getAssetRoot:()=>'/session-assets/token/model/models/a.glb',permitted:()=>true,reportPermitted:()=>false,documentRef,
    fetchRef:()=>new Promise(resolve=>{resolveList=resolve;}),origin:'https://viewer.test'});
  const listing=mounted.list();
  mounted.refresh();
  resolveList({ok:true,json:async()=>({products:[{kind:'ortho',label:'Orthophoto',grantUrl:'/session-products/token/model/ortho/download-grants'}]})});
  assert.equal((await listing).length,1,'the list still loads after a renewal');
  mounted.destroy();
  // Report-only: a renewal does not abort the report download in flight.
  const calls2=[];let release;
  const reportHost2=new Element('div');
  const mounted2=mountViewerProductDownloads({reportHost:reportHost2,getAssetRoot:()=>'/session-assets/token/model/models/a.glb',permitted:()=>false,reportPermitted:()=>true,documentRef,
    fetchRef:(url,options={})=>{calls2.push([url,options.method]);return options.method==='POST'?Promise.resolve({ok:true,json:async()=>({url:'/session-product-downloads/'+'c'.repeat(43)})})
      :new Promise(resolve=>{release=resolve;});},origin:'https://viewer.test'});
  const pending=reportHost2.children[0].children[0].onclick();mounted2.refresh();
  release({ok:true,json:async()=>({products:[{kind:'report',grantUrl:'/session-products/token/model/report/download-grants'}]})});await pending;
  assert.deepEqual(calls2.map(call=>call[1]),[undefined,'POST'],'the report download went ahead');
  mounted2.destroy();
});
