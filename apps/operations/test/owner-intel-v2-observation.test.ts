import { describe,expect,it } from 'vitest';
import { validateOwnerIntelV2Observation,type ReviewedOwnerIntelV2Context } from '../src/worker/owner-intel-v2-observation';
import { validateIntelObservation } from '../src/worker/competitor-intel-ingest-schema';
const TS='2026-10-24T12:00:00Z',NOW=Date.parse(TS),bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
const unknown={value:null,state:'unknown',reason:'not_checked'};
const observed=(value:unknown)=>({value,state:'observed',reason:null});
const page='https://example.test/owned/',profile='https://social.example.test/account';
type Kind='search_console_summary'|'own_site'|'social_presence';
function fixture(kind:Kind='search_console_summary'){
 const source={search_console_summary:'google_search_console',own_site:'hermes_site_monitor',social_presence:'public_web'} as const;
 const subject={search_console_summary:'gsc:site-a',own_site:'own:site-a',social_presence:'social:own:site-a'};
 const provenance={source:source[kind],sourceAccountRef:kind==='search_console_summary'?'gsc-source-a':null,collectedBy:'hermes-competitor-intel',collectedAt:TS,
  asOf:'2026-10-24T11:00:00Z',lastDataDate:kind==='search_console_summary'?'2026-10-03':null,dataRange:kind==='search_console_summary'?{start:'2026-10-01',end:'2026-10-03'}:null,partial:false,partialReason:null,limits:[] as string[]};
 const payloads={
  search_console_summary:{siteUrl:'sc-domain:example.test',period:{start:'2026-10-01',end:'2026-10-03',days:3},totals:{clicks:3,impressions:100,ctrPercent:'3',avgPosition:'2',state:'observed',reason:null},
   daily:[{date:'2026-10-01',clicks:1,impressions:30},{date:'2026-10-02',clicks:1,impressions:30},{date:'2026-10-03',clicks:1,impressions:40}],
   topQueries:[{query:'synthetic service',clicks:3,impressions:100,ctrPercent:'3',avgPosition:'2'}],topPages:[{url:'https://example.test/newly-published',clicks:3,impressions:100,ctrPercent:'3',avgPosition:'2'}],comparison:null,provenance},
  own_site:{canonicalDomain:'example.test',monitoredPages:[{url:page,title:'Synthetic',observedAt:TS,fetchStatus:'ok',contentSha256:'A'.repeat(43),contentLength:12}],changesSincePrevious:[],
   technical:{httpsOk:observed(true),sitemapPageCount:unknown,robotsAllowsIndexing:unknown,avgFetchMs:10},provenance},
  social_presence:{ownerSubjectKey:'own:site-a',profiles:[{platform:'other',url:profile,handle:'synthetic',followers:observed(12),lastPublicPostDate:unknown,profileFound:observed(true),sourceUrl:{url:profile,title:null,observedAt:TS,fetchStatus:'ok'}}],provenance},
 };
 const value:any={schemaVersion:'ci.observation.v1',producerId:'hermes-competitor-intel',operationId:'00000000-0000-4000-8000-000000000001',monitoringBindingId:'binding-a',configurationRevision:1,
  observationKind:kind,subjectKey:subject[kind],sourceSequence:{epoch:'1',counter:'1'},commandBinding:null,observedAt:'2026-10-24T11:00:00Z',completedAt:TS,
  semantics:{observation:'ci.obs.v2',scoring:'concern_0_10.v1'},payload:payloads[kind]};
 const context:ReviewedOwnerIntelV2Context={producerId:value.producerId,monitoringBindingId:'binding-a',configurationRevision:1,observationKind:kind,subjectKey:value.subjectKey,
  source:source[kind],sourceAccountRef:provenance.sourceAccountRef,collectedBy:provenance.collectedBy,
  searchProperties:[{kind:'domain',siteUrl:'sc-domain:example.test',domain:'example.test'}],propertyRefs:[],canonicalDomains:['example.test'],pageUrls:[page,profile],ownerSubjectKeys:['own:site-a'],socialProfileUrls:[profile],providerLagDays:3};
 return {value,context,validate:()=>validateOwnerIntelV2Observation(bytes(value),context,NOW)};
}
function fails(mutate:(value:any)=>void){const f=fixture();mutate(f.value);expect(f.validate).toThrow();}

describe('unactivated owner Intel v2 preparation',()=>{
 it.each(['search_console_summary','own_site','social_presence'] as const)('accepts observed %s only with exact reviewed context',kind=>{
  const f=fixture(kind);expect(f.validate().observationKind).toBe(kind);
  expect(()=>validateIntelObservation(f.value,f.value.producerId,NOW)).toThrow('schema_invalid');
 });
 it('accepts honest GSC partial source_stale and unknown no-covered-days evidence',()=>{
  const f=fixture(),q=f.value.payload;q.provenance.partial=true;q.provenance.partialReason='source_stale';q.provenance.lastDataDate='2026-10-02';q.provenance.limits=['Collected data ends 2026-10-02; cause unknown'];q.daily.pop();q.totals={...q.totals,clicks:2,impressions:60,ctrPercent:'3.333333'};expect(f.validate()).toBeDefined();
  q.provenance.lastDataDate='2026-09-30';q.provenance.dataRange={start:'2026-09-01',end:'2026-09-30'};q.provenance.asOf=null;
  q.totals={clicks:null,impressions:null,ctrPercent:null,avgPosition:null,state:'unknown',reason:'source_stale'};q.daily=[];q.topQueries=[];q.topPages=[];expect(f.validate()).toBeDefined();
 });
 it.each(['daily','topQueries','topPages'])('requires missing-day disclosure for known %s rows even when aggregate totals are unknown',section=>{
  const f=fixture(),q=f.value.payload;
  const known=q[section][0];
  q.totals={clicks:null,impressions:null,ctrPercent:null,avgPosition:null,state:'unknown',reason:'not_checked'};
  q.daily=[];q.topQueries=[];q.topPages=[];q[section]=[known];
  expect(f.validate).toThrow('schema_invalid');
  q.provenance.limits=[section==='daily'?'Daily rows omit 2026-10-02 and 2026-10-03.':'Daily rows omit 2026-10-01, 2026-10-02 and 2026-10-03.'];expect(f.validate()).toBeDefined();
  q.daily=[];q.topQueries=[];q.topPages=[];q.provenance.limits=[];q.provenance.asOf=null;expect(f.validate()).toBeDefined();
 });
 it.each(['own_site','social_presence'] as const)('accepts partial and honest no-data %s without fabricating success',kind=>{
  const f=fixture(kind),q=f.value.payload;q.provenance.partial=true;q.provenance.partialReason='data_limited';q.provenance.limits=['Only the available public facts are reported.'];expect(f.validate()).toBeDefined();
  q.provenance.partial=false;q.provenance.partialReason=null;q.provenance.asOf=null;
  if(kind==='own_site'){q.monitoredPages=[];q.technical={httpsOk:unknown,sitemapPageCount:unknown,robotsAllowsIndexing:unknown,avgFetchMs:null};}
  else for(const p of q.profiles){p.followers={value:null,state:'not_connected',reason:'not_configured'};p.profileFound={value:null,state:'not_connected',reason:'not_configured'};p.sourceUrl.fetchStatus='not_checked';}
  expect(f.validate()).toBeDefined();
 });
 it('accepts all 93 daily rows with inclusive valid dates',()=>{
  const f=fixture(),q=f.value.payload;q.period={start:'2026-07-24',end:'2026-10-24',days:93};
  q.provenance.dataRange={start:q.period.start,end:q.period.end};q.provenance.lastDataDate=q.period.end;
  q.daily=Array.from({length:93},(_,n)=>({date:new Date(Date.parse(q.period.start)+n*86400000).toISOString().slice(0,10),clicks:1,impressions:10}));q.totals={...q.totals,clicks:93,impressions:930,ctrPercent:'10'};
  expect(f.validate()).toBeDefined();
 });
 it('accepts documented recent-range provider delay structurally without claiming provider verification',()=>{
  const f=fixture(),q=f.value.payload;q.period={start:'2026-10-22',end:'2026-10-24',days:3};q.daily=[{date:'2026-10-22',clicks:1,impressions:30},{date:'2026-10-23',clicks:1,impressions:30}];
  q.provenance.dataRange={start:q.period.start,end:q.period.end};q.provenance.lastDataDate='2026-10-23';q.provenance.partial=true;q.provenance.partialReason='provider_data_delay';q.provenance.limits=['Recent provider range may still change.'];expect(f.validate()).toBeDefined();
 });
 it('handles zero-click CTR, zero-impression null CTR, and unavailable average position honestly',()=>{
  const f=fixture(),t=f.value.payload.totals;t.clicks=0;t.ctrPercent='0';expect(f.validate()).toBeDefined();
  t.impressions=0;t.ctrPercent=null;t.avgPosition=null;expect(f.validate()).toBeDefined();
  t.impressions=10;expect(f.validate).toThrow();t.ctrPercent='0';expect(f.validate).toThrow();
  f.value.payload.provenance.limits=['Average position was not reported.'];expect(f.validate()).toBeDefined();
 });
 it('checks CTR tolerance exactly at safe-integer count bounds',()=>{
  const f=fixture(),t=f.value.payload.totals;t.clicks=Number.MAX_SAFE_INTEGER;t.impressions=Number.MAX_SAFE_INTEGER;t.ctrPercent='100';expect(f.validate()).toBeDefined();
  t.ctrPercent='99.989999';expect(f.validate).toThrow();
 });
 it.each([
  ['inclusive days',(v:any)=>{v.payload.period.days=2;}],
  ['invalid date',(v:any)=>{v.payload.period.start='2026-02-30';}],
  ['outside period',(v:any)=>{v.payload.daily[0].date='2026-09-30';}],
  ['duplicate daily',(v:any)=>{v.payload.daily[1].date=v.payload.daily[0].date;}],
  ['descending daily',(v:any)=>{v.payload.daily.reverse();}],
  ['94 daily rows',(v:any)=>{v.payload.daily=Array.from({length:94},()=>v.payload.daily[0]);}],
  ['51 non-excepted rows',(v:any)=>{v.payload.topQueries=Array.from({length:51},()=>v.payload.topQueries[0]);}],
  ['observed null count',(v:any)=>{v.payload.totals.clicks=null;}],
  ['unknown populated metric',(v:any)=>{v.payload.totals.state='unknown';v.payload.totals.reason='not_checked';}],
  ['partial without reason',(v:any)=>{v.payload.provenance.partial=true;}],
  ['reason without partial',(v:any)=>{v.payload.provenance.partialReason='source_stale';}],
  ['asOf after collection',(v:any)=>{v.payload.provenance.asOf='2026-10-24T12:00:01Z';}],
  ['collection after completion',(v:any)=>{v.payload.provenance.collectedAt='2026-10-24T12:00:01Z';}],
  ['last data after range',(v:any)=>{v.payload.provenance.lastDataDate='2026-10-04';}],
  ['reversed data range',(v:any)=>{v.payload.provenance.dataRange.start='2026-10-04';}],
  ['clicks exceed impressions',(v:any)=>{v.payload.totals.clicks=101;}],
  ['CTR above100',(v:any)=>{v.payload.totals.ctrPercent='100.01';}],
  ['CTR mismatch',(v:any)=>{v.payload.totals.ctrPercent='4';}],
  ['zero clicks nonzeroCTR',(v:any)=>{v.payload.totals.clicks=0;}],
  ['negative count',(v:any)=>{v.payload.daily[0].clicks=-1;}],
  ['seven-place decimal',(v:any)=>{v.payload.totals.ctrPercent='3.0000000';}],
  ['Money is not this schema',(v:any)=>{v.payload.totals.spend={micros:'-1',currency:'BAD_CURRENCY'};}],
  ['old source as provider delay',(v:any)=>{v.payload.provenance.partial=true;v.payload.provenance.partialReason='provider_data_delay';v.payload.provenance.lastDataDate='2026-09-30';v.payload.provenance.dataRange.start='2026-09-01';}],
  ['missing day without limits',(v:any)=>{v.payload.daily.pop();}],
  ['bad comparison length',(v:any)=>{v.payload.comparison={previousPeriod:{start:'2026-09-28',end:'2026-09-29',days:2},clicksDeltaPercent:null,impressionsDeltaPercent:null};}],
  ['nonadjacent comparison',(v:any)=>{v.payload.comparison={previousPeriod:{start:'2026-09-27',end:'2026-09-29',days:3},clicksDeltaPercent:null,impressionsDeltaPercent:null};}],
  ['observed data without asOf',(v:any)=>{v.payload.provenance.asOf=null;}],
 ] as const)('rejects %s',(_name,mutate)=>fails(mutate));
 it.each(['https://example.test.evil/path','https://evil-example.test/path','https://person@example.test/path','javascript:alert(1)'])('rejects unauthorized GSC page %s',url=>{
  const f=fixture();f.value.payload.topPages[0].url=url;expect(f.validate).toThrow();
 });
 it('admits new pages and real subdomains only within the reviewed domain property',()=>{
  const f=fixture();f.value.payload.topPages[0].url='http://new.example.test/new-page';expect(f.validate()).toBeDefined();
 });
 it('uses exact reviewed URL-prefix origin/path, without requiring a manual result-page list',()=>{
  const f=fixture();f.context.searchProperties=[{kind:'url_prefix',siteUrl:page,origin:'https://example.test',pathPrefix:'/owned/'}];f.value.payload.siteUrl=page;
  f.value.payload.topPages[0].url='https://example.test/owned/new-page';expect(f.validate()).toBeDefined();
  for(const url of ['https://example.test/outside/','https://example.test/owned-evil/','http://example.test/owned/','https://sub.example.test/owned/','https://example.test/owned/../outside/']){f.value.payload.topPages[0].url=url;expect(f.validate).toThrow();}
 });
 it.each(['producerId','monitoringBindingId','subjectKey','sourceAccountRef','collectedBy'] as const)('requires exact reviewed %s',field=>{
  const f=fixture();if(field==='sourceAccountRef'||field==='collectedBy')f.value.payload.provenance[field]='different';else f.value[field]='different';expect(f.validate).toThrow();
 });
 it('requires exact revision/source/property and does not infer tenant from names',()=>{
  const f=fixture();f.value.configurationRevision=2;expect(f.validate).toThrow();f.value.configurationRevision=1;
  f.value.payload.siteUrl='sc-domain:other.test';expect(f.validate).toThrow();f.value.payload.siteUrl='sc-domain:example.test';f.value.payload.provenance.source='public_web';expect(f.validate).toThrow();
 });
 it('keeps own-site monitored pages and changed SourceRef URLs on the exact list',()=>{
  const f=fixture('own_site');f.value.payload.monitoredPages[0].url='https://example.test/new-page';expect(f.validate).toThrow();
  f.value.payload.monitoredPages[0].url=page;f.value.payload.changesSincePrevious=[{pageUrl:{url:'https://example.test/new-page',title:null,observedAt:TS,fetchStatus:'ok'},changeType:'content_changed',summary:'Synthetic',addedSentences:[],removedSentences:[],detectedAt:TS}];expect(f.validate).toThrow();
  f.value.payload.changesSincePrevious[0].pageUrl.url=page;expect(f.validate()).toBeDefined();
 });
 it('rejects noncanonical own-site hashes and stated-value contradictions',()=>{
  const f=fixture('own_site');f.value.payload.monitoredPages[0].contentSha256='A'.repeat(42)+'B';expect(f.validate).toThrow();f.value.payload.monitoredPages[0].contentSha256='A'.repeat(43);
  f.value.payload.technical.httpsOk.value=null;expect(f.validate).toThrow();f.value.payload.technical.httpsOk={...unknown,value:false};expect(f.validate).toThrow();
 });
 it('never derives no-data from a caller boolean or ignores observed own-site/social facts',()=>{
  for(const kind of ['own_site','social_presence'] as const){const f=fixture(kind);f.value.payload.provenance.asOf=null;expect(f.validate).toThrow();(f.context as any).dataReturned=false;expect(f.validate).toThrow();}
 });
 it('treats measured zero and observed negative facts as data rather than missing values',()=>{
  const f=fixture('own_site'),q=f.value.payload;q.monitoredPages=[];q.technical={httpsOk:unknown,sitemapPageCount:unknown,robotsAllowsIndexing:unknown,avgFetchMs:null};q.provenance.asOf=null;
  expect(f.validate()).toBeDefined();q.technical.avgFetchMs=0;expect(f.validate).toThrow();q.technical.avgFetchMs=null;q.technical.httpsOk=observed(false);expect(f.validate).toThrow();
  const s=fixture('social_presence'),p=s.value.payload.profiles[0];p.followers=unknown;p.lastPublicPostDate=unknown;p.profileFound=observed(false);s.value.payload.provenance.asOf=null;expect(s.validate).toThrow();
 });
 it.each([
  ['own_site','monitoredPages',26],['own_site','changesSincePrevious',21],['social_presence','profiles',11],
 ] as const)('preserves the smaller %s.%s bound', (kind,field,length)=>{
  const f=fixture(kind),rows=f.value.payload[field];f.value.payload[field]=Array.from({length},()=>rows[0]??{});expect(f.validate).toThrow();
 });
 it('keeps provenance limits bounded and rejects unknown fields rather than accepting hidden authority',()=>{
  const f=fixture();f.value.payload.provenance.limits=Array.from({length:51},()=> 'Synthetic limit');expect(f.validate).toThrow();
  f.value.payload.provenance.limits=[];f.value.payload.tenantId='unreviewed';expect(f.validate).toThrow();
 });
 it('requires reviewed social owner/profile/evidence-page URLs',()=>{
  const f=fixture('social_presence');f.value.payload.profiles[0].url='https://social.example.test/different';expect(f.validate).toThrow();
  f.value.payload.profiles[0].url=profile;f.value.payload.ownerSubjectKey='comp:unreviewed';f.value.subjectKey='social:comp:unreviewed';expect(f.validate).toThrow();
 });
 it('keeps GA4 pending explicit providerLimits draft alignment and excludes own Ads',()=>{
  for(const kind of ['ga4_summary','own_ads_checkup']){const f=fixture();f.value.observationKind=kind;expect(f.validate).toThrow('schema_invalid');expect(()=>validateIntelObservation(f.value,f.value.producerId,NOW)).toThrow('schema_invalid');}
 });
 it('bounds bytes/depth and preserves duplicate-key/UTF8 rejection without touching v1 parsing',()=>{
  const f=fixture();expect(()=>validateOwnerIntelV2Observation(new Uint8Array(262145),f.context,NOW)).toThrow('body_too_large');
  for(const raw of ['{"a":1,"\\u0061":2}','{"a":[[[[[[{}]]]]]]}'])expect(()=>validateOwnerIntelV2Observation(new TextEncoder().encode(raw),f.context,NOW)).toThrow('schema_invalid');
  expect(()=>validateOwnerIntelV2Observation(new Uint8Array([0xff]),f.context,NOW)).toThrow('encoding_invalid');
 });
});
