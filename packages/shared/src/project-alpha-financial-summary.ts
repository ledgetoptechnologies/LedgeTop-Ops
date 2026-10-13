export interface ProjectAlphaFinancialSummaryRequestV1 {
  protocolVersion: 1;
  sourceId: string;
  projectPublicId: string;
  cursor?: string | null;
}

export interface ProjectAlphaFinancialInvoiceV2 {
  documentNumber: number | null;
  status: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  dueDate: string | null;
  documentDate: string | null;
  invoicePublicUrl: string | null;
  paymentPublicUrl: string | null;
}

export interface ProjectAlphaFinancialSummaryV2 {
  apiVersion: "2";
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  resource: { type: "project"; externalId: string; publicId: string };
  returnedPageTotals: { invoiceTotal: string; amountPaid: string; balanceDue: string };
  invoices: ProjectAlphaFinancialInvoiceV2[];
  nextCursor: string | null;
}

export type ProjectAlphaFinancialSummaryResultV1 =
  | { ok: true; protocolVersion: 1; summary: ProjectAlphaFinancialSummaryV2 }
  | { ok: false; protocolVersion: 1; code: "disabled" | "misconfigured" | "unavailable" | "not_found" | "incompatible" };

export interface ProjectAlphaFinancialSummaryBinding {
  readProjectAlphaFinancialSummary(input: ProjectAlphaFinancialSummaryRequestV1): Promise<ProjectAlphaFinancialSummaryResultV1>;
}
