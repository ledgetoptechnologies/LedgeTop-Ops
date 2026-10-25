import {expect,it} from 'vitest';
import {projectOwnerIntel,type AcceptedIntel} from '../src/worker/competitor-intel-ingest-projection';
import {validateIntelObservation} from '../src/worker/competitor-intel-ingest-schema';

const time='2026-10-22T23:30:00Z',producer='synthetic-intel';
const stated={value:null,state:'unknown',reason:'not_checked'};
const source={url:'https://example.test/',title:null,observedAt:time,fetchStatus:'not_checked'};
const score={...stated,scale:'concern_0_10',confidence:null};
function row(number:number,subjectKey:string,kind:'competitor_profile'|'change',detectedAt=time):AcceptedIntel{
 const profile={name:subjectKey,canonicalDomain:'example.test',verifiedHomeUrl:null,homepageStatus:source,monitoringSince:null,lastSuccessfulCheckAt:null,
  sitePageCount:{...stated,source:null,checkedAt:null},monitoredPageCount:0,socialProfiles:[],active:false,scopeKey:'synthetic'};
 const change={competitorSubjectKey:'comp:a',detectedAt,pageUrl:source,pageTitle:null,changeType:'content_changed',significance:{value:null,confidence:null},
  category:{value:null,confidence:null},isNewService:stated,isPricingChange:stated,impact:score,summary:'Synthetic change',addedSentences:[],removedSentences:[],
  producerReview:{state:'unreviewed',verdict:null,reviewedAt:null}};
 const observation=validateIntelObservation({schemaVersion:'ci.observation.v1',producerId:producer,operationId:`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`,
  monitoringBindingId:'binding-synthetic',configurationRevision:1,observationKind:kind,subjectKey,sourceSequence:{epoch:'1',counter:'1'},commandBinding:null,
  observedAt:time,completedAt:time,semantics:{observation:'ci.obs.v1',scoring:'concern_0_10.v1'},payload:kind==='competitor_profile'?profile:change},producer,Date.parse(time));
 return {observation,digest:'A'.repeat(43)};
}
it('produces identical owner lists for different database row orders without changing evidence',()=>{
 const rows=[row(1,'comp:z','competitor_profile'),row(2,'comp:a','competitor_profile'),row(3,'change:old','change','2026-10-21T23:30:00Z'),
  row(4,'change:new-a','change'),row(5,'change:new-b','change')];
 const before=JSON.stringify(rows),business={route_key:'synthetic',display_name:'Synthetic Business'};
 const first=projectOwnerIntel(rows,business),reversed=projectOwnerIntel([...rows].reverse(),business);
 expect(first).toBe(reversed);expect(JSON.stringify(rows)).toBe(before);
 const value=JSON.parse(first);
 expect(value.competitors.map((c:{subjectKey:string})=>c.subjectKey)).toEqual(['comp:a','comp:z']);
 expect(value.changes.map((c:{operationId:string})=>c.operationId)).toEqual([rows[4]!.observation.operationId,rows[3]!.observation.operationId,rows[2]!.observation.operationId]);
});
