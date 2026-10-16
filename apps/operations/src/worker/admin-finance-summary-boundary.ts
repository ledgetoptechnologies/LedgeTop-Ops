import { z } from 'zod';
import type {CompanyFinanceSummary,FinanceMoneyBucket,FinancePeriod,FinanceSourceSummary} from '../../../../packages/shared/src/admin-finance-summary';
import {parseDuplicateFreeJson} from './bounded-json';

const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const money=z.string().regex(/^-?(?:0|[1-9][0-9]{0,35})\.[0-9]{2}$/);
const positive=z.string().regex(/^(?:0|[1-9][0-9]{0,35})\.[0-9]{2}$/);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{
  const instant=new Date(value+'T00:00:00.000Z');
  return Number.isFinite(instant.getTime())&&instant.toISOString().slice(0,10)===value;
});
const period=z.object({from:date,to:date,dateBasis:z.literal('stored-calendar-date')}).strict();
const currency=z.string().regex(/^[A-Z]{3}$/);
const bucket=z.object({currency,decimalScale:z.literal(2),
  payments:z.object({count,received:positive.nullable(),adjustedNetIncome:money.nullable(),
    processorFeeQuality:z.object({actual:count,estimated:count,unknown:count}).strict()}).strict(),
  expenses:z.object({count:count.nullable(),total:positive.nullable(),pending:positive.nullable(),
    confirmed:positive.nullable(),reimbursed:positive.nullable()}).strict(),
  recordedOperatingResult:money.nullable(),
  receivables:z.object({count,outstanding:positive,overdue:positive}).strict(),
}).strict();
const summary=z.object({apiVersion:z.literal('2'),sourceInstanceId:z.uuid(),applicationId:z.uuid(),historyEpoch:z.uuid(),requestId:z.uuid(),
  asOf:z.iso.datetime(),period,snapshotSha256:z.string().regex(/^[a-f0-9]{64}$/),scope:z.literal('company'),
  accountingBasis:z.literal('payment-date-current-adjustments-and-recorded-expense-date'),
  coverage:z.object({complete:z.boolean(),currencyPolicy:z.literal('linked-document-currency-only'),
    baseCurrency:currency.nullable(),unknownPaymentCurrencyCount:count,unknownReceivableCurrencyCount:count,unallocatedProjectPaymentCount:count,
    expenseCurrencyKnown:z.boolean(),processorFeeEstimateCount:count,
    recordedExpenseCounts:z.object({total:count,pending:count,confirmed:count,reimbursed:count,other:count}).strict(),
  }).strict(),currencies:z.array(bucket).max(128),
}).strict();

/** Strict aggregate-only wire boundary: unknown fields (including URLs and PII) fail closed. */
export function decodeCompanyFinanceSummary(bytes:Uint8Array,expected:{sourceInstanceId:string;applicationId:string;historyEpoch:string;requestId:string;period:FinancePeriod},now=Date.now()):CompanyFinanceSummary|null{
  if(bytes.byteLength>128*1024)return null;
  let raw:unknown;try{raw=parseDuplicateFreeJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return null;}
  const decoded=summary.safeParse(raw);if(!decoded.success)return null;
  const value=decoded.data;
  if(value.sourceInstanceId!==expected.sourceInstanceId||value.applicationId!==expected.applicationId
    ||value.historyEpoch!==expected.historyEpoch||value.requestId!==expected.requestId
    ||value.period.from!==expected.period.from||value.period.to!==expected.period.to
    ||value.period.dateBasis!==expected.period.dateBasis
    ||Date.parse(value.asOf)>now+60_000||Date.parse(value.asOf)<now-300_000
    ||new Set(value.currencies.map(row=>row.currency)).size!==value.currencies.length)return null;
  const coverage=value.coverage,expenses=coverage.recordedExpenseCounts;
  if(expenses.total!==expenses.pending+expenses.confirmed+expenses.reimbursed+expenses.other
    ||coverage.complete&&(coverage.unknownPaymentCurrencyCount>0||coverage.unknownReceivableCurrencyCount>0||coverage.unallocatedProjectPaymentCount>0
      ||!coverage.expenseCurrencyKnown&&expenses.total>0))return null;
  for(const row of value.currencies){
    const fees=row.payments.processorFeeQuality;
    if(fees.actual+fees.estimated+fees.unknown!==row.payments.count
      ||!coverage.expenseCurrencyKnown&&(row.expenses.count!==null||row.expenses.total!==null
        ||row.expenses.pending!==null||row.expenses.confirmed!==null||row.expenses.reimbursed!==null
        ||row.recordedOperatingResult!==null)
      ||atomic(row.receivables.overdue)>atomic(row.receivables.outstanding))return null;
  }
  return value;
}

function atomic(value:string):bigint{return BigInt(value.replace('.',''));}
function decimal(value:bigint):string{
  const sign=value<0n?'-':'';const digits=(value<0n?-value:value).toString().padStart(3,'0');
  return sign+digits.slice(0,-2)+'.'+digits.slice(-2);
}
function add(left:string|null,right:string|null):string|null{return left===null||right===null?null:decimal(atomic(left)+atomic(right));}
function addCount(left:number,right:number):number{const value=left+right;if(!Number.isSafeInteger(value))throw Error('finance_count_overflow');return value;}

/** A failed source contributes no invented zeros. Available currency groups remain explicitly partial. */
export function combineFinanceSources(sources:readonly FinanceSourceSummary[]):{currencies:FinanceMoneyBucket[];coverageComplete:boolean}|null{
  if(new Set(sources.map(row=>row.sourceId)).size!==sources.length)throw Error('duplicate_finance_source');
  const available=sources.filter(row=>row.status==='ok'&&row.summary!==null);
  if(!available.length)return null;
  const totals=new Map<string,FinanceMoneyBucket>();
  for(const source of available)for(const row of source.summary!.currencies){
    const prior=totals.get(row.currency);
    if(!prior){totals.set(row.currency,row);continue;}
    totals.set(row.currency,{currency:row.currency,decimalScale:2,
      payments:{count:addCount(prior.payments.count,row.payments.count),received:add(prior.payments.received,row.payments.received),
        adjustedNetIncome:add(prior.payments.adjustedNetIncome,row.payments.adjustedNetIncome),processorFeeQuality:{
          actual:addCount(prior.payments.processorFeeQuality.actual,row.payments.processorFeeQuality.actual),
          estimated:addCount(prior.payments.processorFeeQuality.estimated,row.payments.processorFeeQuality.estimated),
          unknown:addCount(prior.payments.processorFeeQuality.unknown,row.payments.processorFeeQuality.unknown)}},
      expenses:{count:prior.expenses.count===null||row.expenses.count===null?null:addCount(prior.expenses.count,row.expenses.count),
        total:add(prior.expenses.total,row.expenses.total),pending:add(prior.expenses.pending,row.expenses.pending),
        confirmed:add(prior.expenses.confirmed,row.expenses.confirmed),reimbursed:add(prior.expenses.reimbursed,row.expenses.reimbursed)},
      recordedOperatingResult:add(prior.recordedOperatingResult,row.recordedOperatingResult),
      receivables:{count:addCount(prior.receivables.count,row.receivables.count),outstanding:add(prior.receivables.outstanding,row.receivables.outstanding)!,
        overdue:add(prior.receivables.overdue,row.receivables.overdue)!}});
  }
  return{currencies:[...totals.values()].sort((a,b)=>a.currency.localeCompare(b.currency)),
    coverageComplete:available.length===sources.length&&available.every(row=>row.summary!.coverage.complete)};
}
