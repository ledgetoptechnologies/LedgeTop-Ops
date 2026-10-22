import {createElement} from "react";
import {describe,expect,it} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {OperationsFinancialSummary} from "../src/client/OperationsHomeApp";
const document={scopeKey:"authority:grant:1",publicId:"doc-1",kind:"invoice" as const,status:"unpaid",currency:"USD",total:"10.00",
  amountPaid:"0.00",balanceDue:"10.00",documentUrl:"https://pa.example.test/?page=public-doc&token=abcdefghijklmnop",
  actionUrl:"https://pa.example.test/?page=stripe-checkout&token=abcdefghijklmnop"};
type Document=Omit<typeof document,"kind"|"amountPaid"|"balanceDue">&{kind:"invoice"|"contract"|"project_invoice";amountPaid:string|null;balanceDue:string|null};
const render=(state:"loading"|"ready"|"unavailable",documents:Document[]=[])=>renderToStaticMarkup(
  createElement(OperationsFinancialSummary,{state,documents}));
const money=(value:number)=>new Intl.NumberFormat(undefined,{style:"currency",currency:"USD"}).format(value);
describe("financial portal presentation",()=>{
  it("renders loading, unavailable, and empty states without stale documents",()=>{
    expect(render("loading")).toContain("Loading financial documents");
    expect(render("unavailable")).toContain("temporarily unavailable");
    expect(render("ready")).toContain("No invoices or contracts");
  });
  it("shows the balance due, the paid share and a pay action for an unpaid invoice",()=>{
    const html=render("ready",[document]);
    expect(html).toContain("Balance due");expect(html).toContain(money(10));expect(html).toContain("1 invoice needs payment");
    expect(html).toContain("Payment due");expect(html).toContain('aria-label="0% paid"');
    expect(html).toContain("Pay now");expect(html).toContain("page=stripe-checkout");
    expect(html).toContain("View document");expect(html).not.toContain("javascript:");
  });
  it("totals what is still owed across invoices and leads with those that need payment",()=>{
    const html=render("ready",[
      {...document,publicId:"paid",total:"40.00",amountPaid:"40.00",balanceDue:"0.00"},
      {...document,publicId:"partial",total:"100.00",amountPaid:"25.00",balanceDue:"75.00"},
      {...document,publicId:"due",total:"10.00"},
    ]);
    expect(html).toContain(money(85));expect(html).toContain("2 invoices need payment");
    expect(html).toContain("Partly paid");expect(html).toContain('aria-label="25% paid"');
    expect(html.indexOf("Partly paid")).toBeLessThan(html.indexOf(">Paid<"));
    expect(html.match(/Pay now/g)).toHaveLength(2);
  });
  it("says so plainly when everything is paid, with no pay buttons",()=>{
    const html=render("ready",[{...document,amountPaid:"10.00",balanceDue:"0.00"}]);
    expect(html).toContain("all paid up");expect(html).toContain(">Paid<");expect(html).not.toContain("Pay now");
    expect(html).not.toContain("Balance due");
  });
  it("lists contracts separately with review and sign",()=>{
    const html=render("ready",[{...document,kind:"contract",status:"sent",amountPaid:null,balanceDue:null}]);
    expect(html).toContain("Contracts");expect(html).toContain("Review and sign");expect(html).not.toContain("Balance due");
    expect(html).not.toContain("Pay now");
  });
});
