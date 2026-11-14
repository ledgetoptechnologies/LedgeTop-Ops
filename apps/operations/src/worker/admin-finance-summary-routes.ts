import type {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {projectAlphaSourceName} from '@ltds/shared';
import type {AdminFinanceSummary,FinancePeriod,FinanceSourceSummary} from '../../../../packages/shared/src/admin-finance-summary';
import type {Env,StaffPrincipal} from './types';
import {readFinanceSummaryAuthority,financeSummaryAuthorityStillCurrent} from './admin-finance-summary-authority';
import {listEnabledProjectAlphaApiV2SourceIds} from './project-alpha-api-v2-connections';
import {readConfiguredCompanyFinanceSummary} from './admin-finance-summary-transport';
import {combineFinanceSources} from './admin-finance-summary-boundary';

const FINANCE_PERIOD_DAYS=30;

/** The last 30 calendar days including today, so the card isn't nearly empty early in a month.
 * The date policy is explicit, shared by both sources and echoed to UI. */
export function currentFinancePeriod(timezone:string,now=new Date()):FinancePeriod{
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part=(kind:string)=>parts.find(value=>value.type===kind)!.value;
  const to=part('year')+'-'+part('month')+'-'+part('day');
  const from=new Date(Date.UTC(+part('year'),+part('month')-1,+part('day')-(FINANCE_PERIOD_DAYS-1))).toISOString().slice(0,10);
  return{from,to,dateBasis:'stored-calendar-date'};
}

export function registerAdminFinanceSummaryRoutes(app:Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>,send:typeof fetch=fetch):void{
  app.get('/api/admin/finance/summary',async c=>{
    c.header('Cache-Control','no-store');
    if(new URL(c.req.url).search)throw new HTTPException(400,{message:'Finance summary does not accept customer or source selectors'});
    const principal=c.get('principal'),connectionSnapshot=c.env.PROJECT_ALPHA_API_V2_CONNECTIONS;
    const authority=await readFinanceSummaryAuthority(c.env.OPS_DB,principal);
    if(!authority)throw new HTTPException(403,{message:'Company financial summary access required'});
    let sourceIds:readonly string[];
    try{sourceIds=listEnabledProjectAlphaApiV2SourceIds({PROJECT_ALPHA_API_V2_CONNECTIONS:connectionSnapshot});}
    catch{throw new HTTPException(503,{message:'Financial sources are unavailable'});}
    if(sourceIds.length>4)throw new HTTPException(503,{message:'Financial source count requires a reviewed aggregation budget'});
    const period=currentFinancePeriod(c.env.DISPLAY_TIMEZONE||'America/Chicago');
    const sources:FinanceSourceSummary[]=await Promise.all(sourceIds.map(async sourceId=>({sourceId,
      label:projectAlphaSourceName(sourceId),
      ...await readConfiguredCompanyFinanceSummary({PROJECT_ALPHA_API_V2_CONNECTIONS:connectionSnapshot},sourceId,period,send)})));
    if(connectionSnapshot!==c.env.PROJECT_ALPHA_API_V2_CONNECTIONS
      ||!await financeSummaryAuthorityStillCurrent(c.env.OPS_DB,authority,principal))
      throw new HTTPException(403,{message:'Company financial summary access changed'});
    const combined=combineFinanceSources(sources);
    const value:AdminFinanceSummary={asOf:new Date().toISOString(),period,sources,combined,complete:combined?.coverageComplete??false};
    return c.json(value);
  });
}
