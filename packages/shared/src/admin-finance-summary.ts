/** Exact PA DECIMAL(*,2) amounts. Never add currencies or convert through Number. */
export type FinanceAmount = string;
export type FinancePeriod = Readonly<{from:string;to:string;dateBasis:'stored-calendar-date'}>;
export type FinanceMoneyBucket = Readonly<{
  currency:string;
  decimalScale:2;
  payments:Readonly<{count:number;received:FinanceAmount|null;adjustedNetIncome:FinanceAmount|null;
    processorFeeQuality:Readonly<{actual:number;estimated:number;unknown:number}>}>;
  expenses:Readonly<{count:number|null;total:FinanceAmount|null;pending:FinanceAmount|null;
    confirmed:FinanceAmount|null;reimbursed:FinanceAmount|null}>;
  recordedOperatingResult:FinanceAmount|null;
  receivables:Readonly<{count:number;outstanding:FinanceAmount;overdue:FinanceAmount}>;
}>;
export type CompanyFinanceSummary = Readonly<{
  apiVersion:'2';sourceInstanceId:string;applicationId:string;historyEpoch:string;requestId:string;
  asOf:string;period:FinancePeriod;snapshotSha256:string;scope:'company';
  accountingBasis:'payment-date-current-adjustments-and-recorded-expense-date';
  coverage:Readonly<{
    complete:boolean;currencyPolicy:'linked-document-currency-only';
    baseCurrency:string|null;unknownPaymentCurrencyCount:number;unknownReceivableCurrencyCount:number;unallocatedProjectPaymentCount:number;
    expenseCurrencyKnown:boolean;processorFeeEstimateCount:number;
    recordedExpenseCounts:Readonly<{total:number;pending:number;confirmed:number;reimbursed:number;other:number}>;
  }>;
  currencies:readonly FinanceMoneyBucket[];
}>;
export type FinanceSourceSummary = Readonly<{
  sourceId:string;label:string;status:'ok'|'unavailable'|'incompatible'|'forbidden';summary:CompanyFinanceSummary|null;
}>;
export type AdminFinanceSummary = Readonly<{
  asOf:string;period:FinancePeriod;complete:boolean;sources:readonly FinanceSourceSummary[];
  combined:Readonly<{currencies:readonly FinanceMoneyBucket[];coverageComplete:boolean}>|null;
}>;
