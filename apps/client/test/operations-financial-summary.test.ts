import {createElement} from "react";
import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {OperationsFinancialSummary} from "../src/client/OperationsHomeApp";
const document={publicId:"doc-1",kind:"invoice" as const,status:"unpaid",currency:"USD",total:"10.00",
  amountPaid:"0.00",balanceDue:"10.00",documentUrl:"https://pa.example.test/?page=public-doc&token=abcdefghijklmnop",
  actionUrl:"https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop"};
const render=(state:"loading"|"ready"|"unavailable",documents:typeof document[]=[])=>renderToStaticMarkup(
  createElement(OperationsFinancialSummary,{state,documents}));
describe("financial portal presentation",()=>{
  it("renders loading, unavailable, and empty states without stale documents",()=>{
    expect(render("loading")).toContain("Loading financial documents");
    expect(render("unavailable")).toContain("temporarily unavailable");
    expect(render("ready")).toContain("No invoices or contracts");
  });
  it("renders PA document and payment actions for a verified invoice",()=>{
    const html=render("ready",[document]);
    expect(html).toContain("Invoice");expect(html).toContain("unpaid");expect(html).toContain("USD 10.00");
    expect(html).toContain("View document");expect(html).toContain("Open payment");expect(html).not.toContain("javascript:");
  });
});
