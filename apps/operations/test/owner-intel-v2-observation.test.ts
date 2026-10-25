import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateOwnerIntelV2Observation,type ReviewedOwnerIntelV2Context } from '../src/worker/owner-intel-v2-observation';
import { validateIntelObservation } from '../src/worker/competitor-intel-ingest-schema';
import { intelSignatureHeaders,verifyIntelSignature } from '../src/worker/competitor-intel-ingest-security';
const TS='2026-10-24T12:00:00Z',NOW=Date.parse(TS),bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
const unknown={value:null,state:'unknown',reason:'not_checked'};
const observed=(value:unknown)=>({value,state:'observed',reason:null});
const page='https://example.test/owned/',profile='https://social.example.test/account';
type Kind='search_console_summary'|'ga4_summary'|'own_site'|'social_presence';
function fixture(kind:Kind='search_console_summary'){
 const source={search_console_summary:'google_search_console',ga4_summary:'google_analytics_4',own_site:'hermes_site_monitor',social_presence:'public_web'} as const;
 const subject={search_console_summary:'gsc:site-a',ga4_summary:'ga4:property-a',own_site:'own:site-a',social_presence:'social:own:site-a'};
 const google=kind==='search_console_summary'||kind==='ga4_summary';
 const provenance={source:source[kind],sourceAccountRef:google?'google-source-a':null,collectedBy:'hermes-competitor-intel',collectedAt:TS,
  asOf:'2026-10-24T11:00:00Z',lastDataDate:google?'2026-10-03':null,dataRange:google?{start:'2026-10-01',end:'2026-10-03'}:null,partial:false,partialReason:null,limits:[] as string[]};
 const payloads={
  search_console_summary:{siteUrl:'sc-domain:example.test',period:{start:'2026-10-01',end:'2026-10-03',days:3},totals:{clicks:3,impressions:100,ctrPercent:'3',avgPosition:'2',state:'observed',reason:null},
   daily:[{date:'2026-10-01',clicks:1,impressions:30},{date:'2026-10-02',clicks:1,impressions:30},{date:'2026-10-03',clicks:1,impressions:40}],
   topQueries:[{query:'synthetic service',clicks:3,impressions:100,ctrPercent:'3',avgPosition:'2'}],topPages:[{url:'https://example.test/newly-published',clicks:3,impressions:100,ctrPercent:'3',avgPosition:'2'}],comparison:null,provenance},
  ga4_summary:{propertyRef:'property-a',propertyDisplayName:'Synthetic Property',providerLimits:{thresholded:false,sampled:false},period:{start:'2026-10-01',end:'2026-10-03',days:3},
   totals:{activeUsers:10,newUsers:3,sessions:15,engagedSessions:9,engagementRatePercent:'60',avgEngagementSeconds:'24.5',keyEvents:'4',state:'observed',reason:null},
   daily:[{date:'2026-10-01',activeUsers:4,sessions:5},{date:'2026-10-02',activeUsers:3,sessions:4},{date:'2026-10-03',activeUsers:3,sessions:6}],
   channels:[{channelGroup:'Organic Search',sessions:15,keyEvents:'4'}],topLandingPages:[{path:'/synthetic',sessions:8,keyEvents:'2'}],keyEventNames:['synthetic_event'],provenance},
  own_site:{canonicalDomain:'example.test',monitoredPages:[{url:page,title:'Synthetic',observedAt:TS,fetchStatus:'ok',contentSha256:'A'.repeat(43),contentLength:12}],changesSincePrevious:[],
   technical:{httpsOk:observed(true),sitemapPageCount:unknown,robotsAllowsIndexing:unknown,avgFetchMs:10},provenance},
  social_presence:{ownerSubjectKey:'own:site-a',profiles:[{platform:'other',url:profile,handle:'synthetic',followers:observed(12),lastPublicPostDate:unknown,profileFound:observed(true),sourceUrl:{url:profile,title:null,observedAt:TS,fetchStatus:'ok'}}],provenance},
 };
 const value:any={schemaVersion:'ci.observation.v1',producerId:'hermes-competitor-intel',operationId:'00000000-0000-4000-8000-000000000001',monitoringBindingId:'binding-a',configurationRevision:1,
  observationKind:kind,subjectKey:subject[kind],sourceSequence:{epoch:'1',counter:'1'},commandBinding:null,observedAt:'2026-10-24T11:00:00Z',completedAt:TS,
  semantics:{observation:'ci.obs.v2',scoring:'concern_0_10.v1'},payload:payloads[kind]};
 const context:ReviewedOwnerIntelV2Context={producerId:value.producerId,monitoringBindingId:'binding-a',configurationRevision:1,observationKind:kind,subjectKey:value.subjectKey,
  source:source[kind],sourceAccountRef:provenance.sourceAccountRef,collectedBy:provenance.collectedBy,
  searchProperties:[{kind:'domain',siteUrl:'sc-domain:example.test',domain:'example.test'}],propertyRefs:kind==='ga4_summary'?['property-a']:[],canonicalDomains:['example.test'],pageUrls:[page,profile],ownerSubjectKeys:['own:site-a'],socialProfileUrls:[profile],providerLagDays:3};
 return {value,context,validate:()=>validateOwnerIntelV2Observation(bytes(value),context,NOW)};
}
function fails(mutate:(value:any)=>void){const f=fixture();mutate(f.value);expect(f.validate).toThrow();}

describe('unactivated owner Intel v2 preparation',()=>{
 it.each(['search_console_summary','ga4_summary','own_site','social_presence'] as const)('accepts observed %s only with exact reviewed context',kind=>{
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
 it('checks exact six-place half-up CTR at safe-integer count bounds and ties',()=>{
  const f=fixture(),t=f.value.payload.totals;t.clicks=Number.MAX_SAFE_INTEGER;t.impressions=Number.MAX_SAFE_INTEGER;t.ctrPercent='100';expect(f.validate()).toBeDefined();
  t.ctrPercent='99.989999';expect(f.validate).toThrow();
  t.clicks=1;t.impressions=512;t.ctrPercent='0.195313';expect(f.validate()).toBeDefined();
  t.ctrPercent='0.195312';expect(f.validate).toThrow();
  t.clicks=1;t.impressions=6;t.ctrPercent='16.666667';expect(f.validate()).toBeDefined();
  t.ctrPercent='16.666666';expect(f.validate).toThrow();
 });
 it('uses the inclusive minus-three-day delay boundary for missing dates, not the last known date',()=>{
  const f=fixture(),q=f.value.payload;q.period={start:'2026-10-21',end:'2026-10-24',days:4};q.daily=[];q.topQueries=[];q.topPages=[];
  q.totals={clicks:null,impressions:null,ctrPercent:null,avgPosition:null,state:'unknown',reason:'provider_data_delay'};
  q.provenance.partial=true;q.provenance.partialReason='provider_data_delay';q.provenance.lastDataDate='2026-10-20';q.provenance.dataRange={start:'2026-10-20',end:'2026-10-24'};
  q.provenance.asOf=null;q.provenance.limits=['Missing daily dates 2026-10-21 through 2026-10-24; recent provider delay.'];
  expect(f.validate()).toBeDefined();q.period.start='2026-10-20';q.period.days=5;expect(f.validate).toThrow();
 });
 it('preserves GA4 missing metrics as null in totals, daily, channel and landing-page rows',()=>{
  const f=fixture('ga4_summary'),q=f.value.payload;
  q.totals.newUsers=null;q.totals.engagementRatePercent=null;q.totals.avgEngagementSeconds=null;q.totals.keyEvents=null;
  q.daily[0].activeUsers=null;q.channels[0].sessions=null;q.channels[0].keyEvents=null;q.topLandingPages[0].sessions=null;q.topLandingPages[0].keyEvents=null;
  const validated:any=f.validate();expect(validated.payload.totals.newUsers).toBeNull();expect(validated.payload.daily[0].activeUsers).toBeNull();
  expect(validated.payload.channels[0].sessions).toBeNull();expect(q.provenance.limits).toEqual([]);
 });
 it.each(['consent_missing','no_property_selected'])('accepts honest not_connected GA4 %s with an empty reviewed property list',reason=>{
  const f=fixture('ga4_summary'),q=f.value.payload;f.context.propertyRefs=[];q.propertyRef=null;q.propertyDisplayName=null;
  q.totals={activeUsers:null,newUsers:null,sessions:null,engagedSessions:null,engagementRatePercent:null,avgEngagementSeconds:null,keyEvents:null,state:'not_connected',reason};
  q.daily=[];q.channels=[];q.topLandingPages=[];q.keyEventNames=[];q.providerLimits={thresholded:null,sampled:null};
  q.provenance.asOf=null;q.provenance.lastDataDate=null;q.provenance.dataRange=null;
  expect(f.validate()).toBeDefined();q.totals.state='unknown';expect(f.validate).toThrow();
 });
 it('accepts a failed GA4 response only without provider flags or invented data',()=>{
  const f=fixture('ga4_summary'),q=f.value.payload;
  q.totals={activeUsers:null,newUsers:null,sessions:null,engagedSessions:null,engagementRatePercent:null,avgEngagementSeconds:null,keyEvents:null,state:'failed',reason:'provider_error'};
  q.daily=[];q.channels=[];q.topLandingPages=[];q.keyEventNames=[];q.providerLimits={thresholded:null,sampled:null};q.provenance.asOf=null;q.provenance.lastDataDate=null;q.provenance.dataRange=null;
  expect(f.validate()).toBeDefined();q.providerLimits.sampled=false;expect(f.validate).toThrow();
 });
 it.each(['thresholded','sampled'])('requires a GA4 %s flag to have data_limited disclosure',flag=>{
  const f=fixture('ga4_summary'),q=f.value.payload;q.providerLimits[flag]=true;expect(f.validate).toThrow();
  q.provenance.partial=true;q.provenance.partialReason='data_limited';expect(f.validate).toThrow();
  q.provenance.limits=[`Provider reported ${flag} data.`];expect(f.validate()).toBeDefined();
  q.provenance.partialReason='provider_data_delay';expect(f.validate).toThrow();
 });
 it('allows exactly 93 GA4 daily entries without weakening other arrays',()=>{
  const f=fixture('ga4_summary'),q=f.value.payload;q.period={start:'2026-07-24',end:'2026-10-24',days:93};q.provenance.dataRange={start:q.period.start,end:q.period.end};q.provenance.lastDataDate=q.period.end;
  q.daily=Array.from({length:93},(_,n)=>({date:new Date(Date.parse(q.period.start)+n*86400000).toISOString().slice(0,10),activeUsers:null,sessions:1}));
  expect(f.validate()).toBeDefined();q.daily.push(q.daily[92]);expect(f.validate).toThrow();
 });
 it.each([
  ['missing providerLimits',(q:any)=>{delete q.providerLimits;}],
  ['mixed null provider flags',(q:any)=>{q.providerLimits.thresholded=null;}],
  ['both null provider flags with reports',(q:any)=>{q.providerLimits={thresholded:null,sampled:null};}],
  ['new users exceed active',(q:any)=>{q.totals.newUsers=11;}],
  ['engaged sessions exceed sessions',(q:any)=>{q.totals.engagedSessions=16;}],
  ['negative count',(q:any)=>{q.daily[0].sessions=-1;}],
  ['seven-place decimal',(q:any)=>{q.totals.keyEvents='1.0000001';}],
  ['unknown totals with values',(q:any)=>{q.totals.state='unknown';q.totals.reason='not_checked';}],
  ['all observed metrics null',(q:any)=>{for(const k of Object.keys(q.totals))if(!['state','reason'].includes(k))q.totals[k]=null;}],
  ['51 non-daily rows',(q:any)=>{q.channels=Array.from({length:51},()=>q.channels[0]);}],
  ['missing daily date without limit',(q:any)=>{q.daily.pop();}],
  ['duplicate daily date',(q:any)=>{q.daily[1].date=q.daily[0].date;}],
  ['daily outside period',(q:any)=>{q.daily[0].date='2026-09-30';}],
  ['unreviewed property',(q:any)=>{q.propertyRef='other-property';}],
  ['provider delay',(q:any)=>{q.provenance.partial=true;q.provenance.partialReason='provider_data_delay';q.provenance.limits=['Recent delay'];}],
  ['ad-hoc provider facts',(q:any)=>{q.providerFacts={thresholded:false};}],
  ['user-level field',(q:any)=>{q.userId='synthetic-private-id';}],
 ] as const)('rejects GA4 %s',(_name,mutate)=>{
  const f=fixture('ga4_summary');mutate(f.value.payload);expect(f.validate).toThrow();
 });
 it.each(['channels','topLandingPages','keyEventNames'])('requires daily-gap limits for reported GA4 %s even without aggregate metrics',section=>{
  const f=fixture('ga4_summary'),q=f.value.payload,known=q[section][0];
  for(const k of Object.keys(q.totals))if(!['state','reason'].includes(k))q.totals[k]=null;q.totals.state='unknown';q.totals.reason='not_checked';
  q.daily=[];q.channels=[];q.topLandingPages=[];q.keyEventNames=[];q[section]=[known];expect(f.validate).toThrow();
  q.provenance.limits=['Daily coverage is unavailable for 2026-10-01 through 2026-10-03.'];expect(f.validate()).toBeDefined();
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
 it('excludes own Ads after the explicit GA4-only draft3 extension',()=>{
  const f=fixture();f.value.observationKind='own_ads_checkup';expect(f.validate).toThrow('schema_invalid');expect(()=>validateIntelObservation(f.value,f.value.producerId,NOW)).toThrow('schema_invalid');
 });
 it('bounds bytes/depth and preserves duplicate-key/UTF8 rejection without touching v1 parsing',()=>{
  const f=fixture();expect(()=>validateOwnerIntelV2Observation(new Uint8Array(262145),f.context,NOW)).toThrow('body_too_large');
  for(const raw of ['{"a":1,"\\u0061":2}','{"a":[[[[[[{}]]]]]]}'])expect(()=>validateOwnerIntelV2Observation(new TextEncoder().encode(raw),f.context,NOW)).toThrow('schema_invalid');
  expect(()=>validateOwnerIntelV2Observation(new Uint8Array([0xff]),f.context,NOW)).toThrow('encoding_invalid');
 });
});

// Optional local receipt check. The canonical note is not fetched by tests and
// is never a source of review authority; the fixture scope below is fixed.
const peerNotePath=process.env.OWNER_INTEL_V2_FIXTURE_NOTE;
it.runIf(Boolean(peerNotePath))('reconciles the 23 available canonical draft3 fixtures without hiding the known prose conflict',async()=>{
 const noteBytes=readFileSync(peerNotePath!);
 expect(createHash('sha256').update(noteBytes).digest('hex')).toBe('14d8fdeadbc2b50acc27c48d53c3946eb7c46499ad2fb1ebbfaafe6b7cecd8d4');
 const pattern=/### `([^`]+)`[^\n]*? (accept|reject) [^\n]*\r?\nSHA-256: `([a-f0-9]{64})`\s*```json\r?\n([\s\S]*?)\r?\n```/g;
 const vectors=[...noteBytes.toString('utf8').matchAll(pattern)];expect(vectors).toHaveLength(23);
 const mismatches:string[]=[];let signatures=0;
 for(const match of vectors){
  const [,name,expected,hash,raw]=match;
  expect(createHash('sha256').update(raw!,'utf8').digest('hex'),name).toBe(hash);
  const frame=JSON.parse(raw!),{headers,...envelope}=frame;
  const kind=envelope.observationKind as Kind;
  const base=fixture(kind).context;
  const context:ReviewedOwnerIntelV2Context={...base,producerId:'hermes-competitor-intel',monitoringBindingId:'FIXTURE-BINDING-LTDS',configurationRevision:1,
   subjectKey:kind==='search_console_summary'?'gsc:ltds-fixture':kind==='ga4_summary'?'ga4:ltds-fixture':kind==='own_site'?'own:ltds-fixture':'social:own:ltds-fixture',
   sourceAccountRef:'fixture-account-ltds',collectedBy:'fixture-generator',searchProperties:[{kind:'url_prefix',siteUrl:'https://ltds-fixture.example/',origin:'https://ltds-fixture.example',pathPrefix:'/'}],
   propertyRefs:['fixture-property-1'],canonicalDomains:['ltds-fixture.example'],pageUrls:['https://ltds-fixture.example/'],ownerSubjectKeys:['own:ltds-fixture'],socialProfileUrls:[]};
  if(headers){
   const request=new Request('https://incoming.ledgetopdroneservices.com/api/competitor-intel/ingest/v1/observations',{method:'POST',headers,body:JSON.stringify(envelope)});
   const signed=intelSignatureHeaders(request,Date.parse('2026-10-25T00:00:00Z'));
   await verifyIntelSignature(bytes(envelope),signed,{producer_id:'hermes-competitor-intel',key_id:'test-key-1',public_key:'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',key_revision:1,state:'active'});signatures++;
  }
  let actual='accept';try{validateOwnerIntelV2Observation(bytes(envelope),context,Date.parse('2026-10-25T00:00:00Z'));}catch{actual='reject';}
  if(actual!==expected)mismatches.push(name!);
  expect(()=>validateIntelObservation(envelope,'hermes-competitor-intel',Date.parse('2026-10-25T00:00:00Z'))).toThrow('schema_invalid');
 }
 expect(signatures).toBe(10);
 // Root explicitly retained the not_connected-only null-property rule. The
 // peer's positive unknown/no_property_selected contradicts that prose.
 expect(mismatches).toEqual(['ga4-unknown-no-property-selected.json']);
 console.info('Canonical peer receipt: 23 exact UTF-8 hashes verified; 10 TEST signatures verified; 22 expected outcomes matched; 1 explicit null-property/state contract conflict. Remaining 45 fixture bytes unavailable.');
});
