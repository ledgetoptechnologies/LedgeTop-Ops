import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {Miniflare} from 'miniflare';
import {Hono} from 'hono';
import type {CompanyFinanceSummary,FinanceMoneyBucket,FinanceSourceSummary} from '../../../packages/shared/src/admin-finance-summary';
import type {Env,StaffPrincipal} from '../src/worker/types';
import {decodeCompanyFinanceSummary,combineFinanceSources} from '../src/worker/admin-finance-summary-boundary';
import {readConfiguredCompanyFinanceSummary} from '../src/worker/admin-finance-summary-transport';
import {readFinanceSummaryAuthority} from '../src/worker/admin-finance-summary-authority';
import {currentFinancePeriod,registerAdminFinanceSummaryRoutes} from '../src/worker/admin-finance-summary-routes';

const sourceInstanceId='11111111-1111-4111-8111-111111111111',applicationId='22222222-2222-4222-8222-222222222222',historyEpoch='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444';
const period={from:'2026-10-01',to:'2026-10-16',dateBasis:'stored-calendar-date' as const};
function bucket(currency='USD',received='9007199254740993.01'):FinanceMoneyBucket{return{currency,decimalScale:2,payments:{count:1,received,adjustedNetIncome:received,processorFeeQuality:{actual:1,estimated:0,unknown:0}},expenses:{count:null,total:null,pending:null,confirmed:null,reimbursed:null},recordedOperatingResult:null,receivables:{count:1,outstanding:'100.00',overdue:'25.00'}};}
function payload(currencies=[bucket()]):CompanyFinanceSummary{return{apiVersion:'2',sourceInstanceId,applicationId,historyEpoch,requestId,asOf:new Date().toISOString(),period,snapshotSha256:'a'.repeat(64),scope:'company',accountingBasis:'payment-date-current-adjustments-and-recorded-expense-date',coverage:{complete:false,currencyPolicy:'linked-document-currency-only',baseCurrency:null,unknownPaymentCurrencyCount:0,unknownReceivableCurrencyCount:0,unallocatedProjectPaymentCount:0,expenseCurrencyKnown:false,processorFeeEstimateCount:0,recordedExpenseCounts:{total:1,pending:1,confirmed:0,reimbursed:0,other:0}},currencies};}
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const expected={sourceInstanceId,applicationId,historyEpoch,requestId,period};
function response(value:unknown=payload()):Response{return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}});}
const connections=JSON.stringify({version:1,instances:{'project-alpha:primary':{sourceId:'project-alpha:primary',enabled:true,baseUrl:'https://pa.test',apiKey:'fixture-key',sourceInstanceId,applicationId,historyEpoch}}});
const envConnection={PROJECT_ALPHA_API_V2_CONNECTIONS:connections};

describe('exact aggregate boundary',()=>{
  it('preserves amounts above safe floating-point precision and separates currencies',()=>{
    const first=payload([bucket(),bucket('CAD','12.34')]),second=payload([bucket('USD','0.02')]);
    expect(decodeCompanyFinanceSummary(encode(first),expected)).toEqual(first);
    const sources:FinanceSourceSummary[]=[{sourceId:'one',label:'One',status:'ok',summary:first},{sourceId:'two',label:'Two',status:'ok',summary:second},{sourceId:'offline',label:'Offline',status:'unavailable',summary:null}];
    const combined=combineFinanceSources(sources)!;
    expect(combined.coverageComplete).toBe(false);
    expect(combined.currencies.map(row=>[row.currency,row.payments.received,row.expenses.total])).toEqual([['CAD','12.34',null],['USD','9007199254740993.03',null]]);
    expect(combineFinanceSources(sources.slice(2))).toBeNull();
    expect(()=>combineFinanceSources([sources[0]!,sources[0]!])).toThrow('duplicate_finance_source');
  });
  it.each(['sourceInstanceId','applicationId','historyEpoch','requestId'])('rejects mismatched %s',key=>{
    expect(decodeCompanyFinanceSummary(encode({...payload(),[key]:'55555555-5555-4555-8555-555555555555'}),expected)).toBeNull();
  });
  it('rejects private extra fields, duplicate members, wrong periods and misleading completeness',()=>{
    expect(decodeCompanyFinanceSummary(encode({...payload(),documentUrl:'https://pa.test/?token=secret'}),expected)).toBeNull();
    expect(decodeCompanyFinanceSummary(new TextEncoder().encode(JSON.stringify(payload()).replace('"scope":"company"','"scope":"company","scope":"company"')),expected)).toBeNull();
    expect(decodeCompanyFinanceSummary(encode({...payload(),period:{...period,to:'2026-10-15'}}),expected)).toBeNull();
    expect(decodeCompanyFinanceSummary(encode({...payload(),coverage:{...payload().coverage,complete:true}}),expected)).toBeNull();
    expect(decodeCompanyFinanceSummary(encode(payload([bucket(),bucket()])),expected)).toBeNull();
  });
  it('uses the configured business calendar across UTC month boundaries',()=>{
    expect(currentFinancePeriod('America/Chicago',new Date('2026-11-01T03:00:00Z'))).toEqual({from:'2026-10-01',to:'2026-10-31',dateBasis:'stored-calendar-date'});
  });
  it('accepts explicit USD expense reporting without assigning those expenses to CAD',()=>{
    const usd:FinanceMoneyBucket={...bucket('USD','300.00'),expenses:{count:2,total:'100.00',pending:'25.00',confirmed:'75.00',reimbursed:'0.00'},recordedOperatingResult:'200.00'};
    const cad:FinanceMoneyBucket={...bucket('CAD','20.00'),expenses:{count:0,total:'0.00',pending:'0.00',confirmed:'0.00',reimbursed:'0.00'},recordedOperatingResult:'20.00'};
    const value={...payload([usd,cad]),coverage:{...payload().coverage,complete:true,currencyPolicy:'explicit-company-base-and-linked-document-currency' as const,
      baseCurrency:'USD',expenseCurrencyKnown:true,recordedExpenseCounts:{total:2,pending:1,confirmed:1,reimbursed:0,other:0}}};
    expect(decodeCompanyFinanceSummary(encode(value),expected)).toEqual(value);
    expect(decodeCompanyFinanceSummary(encode({...value,currencies:[usd,{...cad,expenses:usd.expenses}]}),expected)).toBeNull();
    expect(decodeCompanyFinanceSummary(encode({...value,coverage:{...value.coverage,baseCurrency:null}}),expected)).toBeNull();
    expect(decodeCompanyFinanceSummary(encode({...value,currencies:[{...usd,recordedOperatingResult:'201.00'},cad]}),expected)).toBeNull();
  });
});

describe('bounded credential transport',()=>{
  it('sends only a pinned read to the configured origin',async()=>{
    const send=vi.fn<typeof fetch>(async(input,init)=>{
      expect(String(input)).toBe('https://pa.test/api/v2/financial-summary?from=2026-10-01&to=2026-10-16');
      expect(init).toMatchObject({method:'GET',redirect:'manual',credentials:'omit',cache:'no-store'});
      expect(new Headers(init!.headers).get('X-PA-Application-ID')).toBe(applicationId);return response();
    });
    expect((await readConfiguredCompanyFinanceSummary(envConnection,'project-alpha:primary',period,send)).status).toBe('ok');
    expect(send).toHaveBeenCalledOnce();
  });
  it('does not follow redirects or accept cookies, private fields, oversized bodies or revoked keys',async()=>{
    for(const upstream of [new Response(null,{status:302,headers:{Location:'https://other.test'}}),new Response('{}',{headers:{'Set-Cookie':'session=x'}}),response({...payload(),clientName:'Private'}),new Response('x'.repeat(128*1024+1),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}})]){
      const send=vi.fn<typeof fetch>(async()=>upstream);expect((await readConfiguredCompanyFinanceSummary(envConnection,'project-alpha:primary',period,send)).status).toBe('incompatible');expect(send).toHaveBeenCalledOnce();
    }
    expect((await readConfiguredCompanyFinanceSummary(envConnection,'project-alpha:primary',period,async()=>new Response(null,{status:403}))).status).toBe('forbidden');
  });
  it('bounds a fetch or body reader even when upstream ignores cancellation',async()=>{
    expect((await readConfiguredCompanyFinanceSummary(envConnection,'project-alpha:primary',period,()=>new Promise(()=>{}),20)).status).toBe('unavailable');
    const body=new ReadableStream<Uint8Array>({start(){}});
    expect((await readConfiguredCompanyFinanceSummary(envConnection,'project-alpha:primary',period,async()=>new Response(body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}}),20)).status).toBe('unavailable');
  });
});

let runtime:Miniflare,db:D1Database;
const principal:StaffPrincipal={id:'owner',email:'owner@example.test',displayName:'Owner',accessSubject:'subject-owner',projectAlphaUserId:null,accessExpiresAt:Math.floor(Date.now()/1000)+3600};
beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default {fetch(){return new Response("ok")}}',d1Databases:['OPS']});db=await runtime.getD1Database('OPS') as D1Database;
  await db.batch([
    'CREATE TABLE staff_users(id TEXT,email TEXT,access_subject TEXT,status TEXT)',
    'CREATE TABLE native_staff_profiles(staff_id TEXT,login_email TEXT,version INTEGER)',
    'CREATE TABLE native_staff_admissions(staff_id TEXT,bound_access_subject TEXT,active INTEGER,version INTEGER)',
    'CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT)',
    'CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT)',
    'CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT)',
    'CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT)',
  ].map(sql=>db.prepare(sql)));
},30000);
beforeEach(async()=>{
  await db.batch(['staff_users','native_staff_profiles','native_staff_admissions','staff_role_assignments','local_staff_role_assignments','role_permissions','staff_permission_overrides'].map(table=>db.prepare('DELETE FROM '+table)));
  await db.batch([
    db.prepare("INSERT INTO staff_users VALUES('owner','owner@example.test','subject-owner','active')"),
    db.prepare("INSERT INTO native_staff_profiles VALUES('owner','owner@example.test',1)"),
    db.prepare("INSERT INTO native_staff_admissions VALUES('owner','subject-owner',1,1)"),
    db.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global')"),
    db.prepare("INSERT INTO role_permissions VALUES('role-owner','finance.summary.view')"),
  ]);
});
afterAll(async()=>{await runtime?.dispose();});

function app(send:typeof fetch){const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',true);await next();});registerAdminFinanceSummaryRoutes(app,send);return app;}
function environment(){return{OPS_DB:db,DISPLAY_TIMEZONE:'America/Chicago',...envConnection} as Env;}
describe('live aggregate authorization',()=>{
  it.each([
    "UPDATE staff_role_assignments SET role_id='custom-finance'",
    "DELETE FROM role_permissions",
    "UPDATE native_staff_admissions SET active=0",
    "UPDATE native_staff_admissions SET bound_access_subject='other'",
    "UPDATE staff_users SET access_subject='other'",
  ])('does not authorize through stale identity or broad dashboard/admin labels: %s',async sql=>{
    await db.prepare(sql).run();
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('owner','finance.summary.view','allow','global')").run();
    // An explicit current financial allow still needs a currently admitted
    // administrator; the missing-role-permission case is tested separately.
    if(sql==='DELETE FROM role_permissions'){
      await db.prepare('DELETE FROM staff_permission_overrides').run();
      await db.prepare("INSERT INTO staff_permission_overrides VALUES('owner','finance.summary.view','allow','division')").run();
    }
    expect(await readFinanceSummaryAuthority(db,principal)).toBeNull();
    expect(await readFinanceSummaryAuthority(db,{...principal,accessExpiresAt:1})).toBeNull();
  });
  it('requires both a current native admin and an explicit global financial grant, including all denies',async()=>{
    expect(await readFinanceSummaryAuthority(db,principal)).not.toBeNull();
    for(const scope of ['global','division','assigned','own']){
      await db.prepare("INSERT INTO staff_permission_overrides VALUES('owner','finance.summary.view','deny',?)").bind(scope).run();
      const send=vi.fn<typeof fetch>(async()=>response());const result=await app(send).request('https://ops.test/api/admin/finance/summary',{},environment());
      expect(result.status).toBe(403);expect(send).not.toHaveBeenCalled();
      await db.prepare('DELETE FROM staff_permission_overrides').run();
    }
    await db.prepare("UPDATE staff_role_assignments SET scope='division'").run();expect(await readFinanceSummaryAuthority(db,principal)).toBeNull();
  });
  it.each(['staff','admission','profile','permission'] as const)('does not disclose if %s authority changes while PA is fetched',async kind=>{
    const send=vi.fn<typeof fetch>(async()=>{
      const mutations={staff:"UPDATE staff_users SET status='inactive'",admission:'UPDATE native_staff_admissions SET version=version+1',profile:'UPDATE native_staff_profiles SET version=version+1',permission:"INSERT INTO staff_permission_overrides VALUES('owner','finance.summary.view','deny','global')"};
      await db.prepare(mutations[kind]).run();return response({...payload(),period:currentFinancePeriod('America/Chicago')});
    });
    const result=await app(send).request('https://ops.test/api/admin/finance/summary',{},environment());expect(result.status).toBe(403);expect(send).toHaveBeenCalledOnce();
    expect(await result.text()).not.toContain('9007199254740993');
  });
  it('returns no-store exact aggregates and rejects browser selectors before sending',async()=>{
    const send=vi.fn<typeof fetch>(async()=>response({...payload(),period:currentFinancePeriod('America/Chicago')}));
    const router=app(send);const result=await router.request('https://ops.test/api/admin/finance/summary',{},environment());
    expect(result.status).toBe(200);expect(result.headers.get('Cache-Control')).toBe('no-store');
    const body=await result.json() as {complete:boolean;combined:{currencies:FinanceMoneyBucket[]}};expect(body.complete).toBe(false);expect(body.combined.currencies[0]!.payments.received).toBe('9007199254740993.01');
    send.mockClear();expect((await router.request('https://ops.test/api/admin/finance/summary?sourceId=other',{},environment())).status).toBe(400);expect(send).not.toHaveBeenCalled();
  });
});
