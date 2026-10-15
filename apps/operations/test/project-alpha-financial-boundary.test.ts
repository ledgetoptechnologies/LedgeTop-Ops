import { describe, expect, it } from "vitest";
import { decodeProjectAlphaFinancialPage, type FinancialExpectation } from "../src/worker/project-alpha-financial-boundary";

const id = "150cb108-af37-4973-ab6e-f6d991a6e8c8";
const expected: FinancialExpectation = {
  sourceInstanceId: id, applicationId: id, historyEpoch: id, requestId: id, paOrigin: "https://pa.example.test",
  selector: { kind: "client", externalId: "customer-1", publicId: "a".repeat(32), revision: "3", projectionSha256: "b".repeat(64), authorizationGeneration: "59" },
};
function fixture() {
  return {
    apiVersion: "2", sourceInstanceId: id, applicationId: id, historyEpoch: id, requestId: id,
    selector: { ...expected.selector }, snapshot: { sha256: "c".repeat(64), documentCount: 1 },
    documents: [{ publicId: "d".repeat(32), kind: "invoice", status: "unpaid", currency: "USD", total: "400.00", amountPaid: "0.00", balanceDue: "400.00",
      documentUrl: "https://pa.example.test/?page=public-doc&token=abcdefghijklmnop", actionUrl: "https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop" }],
    nextCursor: null as string | null,
  };
}
type Fixture = ReturnType<typeof fixture>;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
describe("unrouted PA financial response boundary", () => {
  it("accepts exact lineage and freezes nested data without granting recipient access", () => {
    const result = decodeProjectAlphaFinancialPage(bytes(fixture()), expected);
    expect(result?.documents[0]?.balanceDue).toBe("400.00");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.documents[0])).toBe(true);
    expect(Object.isFrozen(result?.selector)).toBe(true);
  });
  it.each(["organization", "client", "project"] as const)("supports explicit %s selectors", kind => {
    const value = fixture(); value.selector.kind = kind;
    expect(decodeProjectAlphaFinancialPage(bytes(value), { ...expected, selector: { ...expected.selector, kind } })).not.toBeNull();
  });
  const mutations: [string, (value: Fixture) => void][] = [
    ["source drift", v => { v.sourceInstanceId = "250cb108-af37-4973-ab6e-f6d991a6e8c8"; }],
    ["application drift", v => { v.applicationId = "250cb108-af37-4973-ab6e-f6d991a6e8c8"; }],
    ["history drift", v => { v.historyEpoch = "250cb108-af37-4973-ab6e-f6d991a6e8c8"; }],
    ["request mismatch", v => { v.requestId = "250cb108-af37-4973-ab6e-f6d991a6e8c8"; }],
    ["customer drift", v => { v.selector.externalId = "customer-2"; }],
    ["public identity drift", v => { v.selector.publicId = "e".repeat(32); }],
    ["revision drift", v => { v.selector.revision = "4"; }],
    ["zero revision", v => { v.selector.revision = "0"; }],
    ["hash drift", v => { v.selector.projectionSha256 = "e".repeat(64); }],
    ["authority drift", v => { v.selector.authorizationGeneration = "60"; }],
    ["unknown private field", v => { Object.assign(v.documents[0]!, { email: "private@example.test" }); }],
    ["numeric money", v => { Object.assign(v.documents[0]!, { total: 400 }); }],
    ["exponent money", v => { v.documents[0]!.total = "4e2"; }],
    ["leading zero money", v => { v.documents[0]!.total = "0400.00"; }],
    ["negative money", v => { v.documents[0]!.balanceDue = "-1.00"; }],
    ["precision overflow", v => { v.documents[0]!.total = "1234567890123456789.00"; }],
    ["lowercase currency", v => { v.documents[0]!.currency = "usd"; }],
    ["draft disclosure", v => { v.documents[0]!.status = "draft"; }],
    ["paid outstanding", v => { v.documents[0]!.status = "paid"; }],
    ["zero balance action", v => { v.documents[0]!.balanceDue = "0.00"; }],
    ["duplicate document", v => { v.documents.push({ ...v.documents[0]! }); v.snapshot.documentCount = 2; }],
    ["oversized count", v => { v.snapshot.documentCount = 10001; }],
    ["short count", v => { v.snapshot.documentCount = 0; }],
    ["empty continuation", v => { v.documents = []; v.nextCursor = "abc"; }],
    ["extra continuation", v => { v.nextCursor = "abc"; }],
  ];
  it.each(mutations)("rejects %s", (_label, mutate) => {
    const value = fixture(); mutate(value);
    expect(decodeProjectAlphaFinancialPage(bytes(value), expected)).toBeNull();
  });
  it.each([
    "http://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop",
    "https://evil.example.test/?page=stripe-checkout&token=abcdefghijklmnop",
    "https://pa.example.test.evil.test/?page=stripe-checkout&token=abcdefghijklmnop",
    "https://owner@pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop",
    "https://pa.example.test:8443/?page=stripe-checkout&token=abcdefghijklmnop",
    "https://pa.example.test/admin?page=stripe-checkout&token=abcdefghijklmnop",
    "https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop#secret",
    "https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop&redirect=https://evil.test",
    "https://pa.example.test/?page=stripe-checkout&page=public-doc&token=abcdefghijklmnop",
    "https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop&token=otherabcdefghijklmnop",
    "https://pa.example.test/?page=public-doc&token=abcdefghijklmnop",
    "https://pa.example.test/?page=stripe-checkout&token=differentabcdefghijklmnop",
    `https://pa.example.test/?page=stripe-checkout&token=${"a".repeat(65)}`,
  ])("rejects untrusted action URL %s", actionUrl => {
    const value = fixture(); value.documents[0]!.actionUrl = actionUrl;
    expect(decodeProjectAlphaFinancialPage(bytes(value), expected)).toBeNull();
  });
  it("rejects duplicate JSON keys, invalid UTF8 and excessive bytes", () => {
    const json = JSON.stringify(fixture()).replace('"apiVersion":"2"', '"apiVersion":"2","apiVersion":"2"');
    expect(decodeProjectAlphaFinancialPage(new TextEncoder().encode(json), expected)).toBeNull();
    expect(decodeProjectAlphaFinancialPage(new Uint8Array([0xff]), expected)).toBeNull();
    expect(decodeProjectAlphaFinancialPage(new Uint8Array(128 * 1024 + 1), expected)).toBeNull();
  });
  it("rejects continuation snapshot drift", () => {
    expect(decodeProjectAlphaFinancialPage(bytes(fixture()), { ...expected, snapshotSha256: "e".repeat(64) })).toBeNull();
    expect(decodeProjectAlphaFinancialPage(bytes(fixture()), { ...expected, snapshotSha256: "c".repeat(64) })).not.toBeNull();
  });
  it("accepts a pending contract with same existing signing URL, suppresses other contract actions", () => {
    const value = fixture(); Object.assign(value.documents[0]!, { kind: "contract", status: "pending", amountPaid: null, balanceDue: null,
      actionUrl: value.documents[0]!.documentUrl });
    expect(decodeProjectAlphaFinancialPage(bytes(value), expected)).not.toBeNull();
    value.documents[0]!.status = "completed";
    expect(decodeProjectAlphaFinancialPage(bytes(value), expected)).toBeNull();
    Object.assign(value.documents[0]!, { actionUrl: null, documentUrl: null });
    expect(decodeProjectAlphaFinancialPage(bytes(value), expected)).not.toBeNull();
  });
  it("suppresses paid bearer URLs but still permits historical paid metadata", () => {
    const value = fixture(); Object.assign(value.documents[0]!, { status: "paid", amountPaid: "400.00", balanceDue: "0.00", actionUrl: null });
    expect(decodeProjectAlphaFinancialPage(bytes(value), expected)).toBeNull();
    Object.assign(value.documents[0]!, { documentUrl: null });
    expect(decodeProjectAlphaFinancialPage(bytes(value), expected)).not.toBeNull();
  });
  it("accepts project invoice overdue parity with PA checkout eligibility", () => {
    const value = fixture(); Object.assign(value.documents[0]!, { kind: "project_invoice", status: "overdue" });
    expect(decodeProjectAlphaFinancialPage(bytes(value), expected)).not.toBeNull();
  });
});
