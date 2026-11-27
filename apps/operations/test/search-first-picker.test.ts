import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { filterPickerOptions, type PickerOption } from "../src/client/SearchFirstPicker";

const options: PickerOption[] = [
  { value: "a", label: "Harbor Surveys" },
  { value: "b", label: "Quay Holdings", detail: "harbor district" },
  { value: "c", label: "Ridge Partners" },
];

describe("search-first picker", () => {
  it("lists nothing until the user types, then filters on label and detail, case-insensitive", () => {
    expect(filterPickerOptions(options, "")).toEqual([]);
    expect(filterPickerOptions(options, "   ")).toEqual([]);
    expect(filterPickerOptions(options, "HARBOR").map(item => item.value)).toEqual(["a", "b"]);
    expect(filterPickerOptions(options, "ridge").map(item => item.value)).toEqual(["c"]);
    expect(filterPickerOptions(options, "nothing")).toEqual([]);
  });
  it("caps the list so a short query never dumps every client", () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ value: `v${index}`, label: `Client ${index}` }));
    expect(filterPickerOptions(many, "client")).toHaveLength(50);
  });
});

const read = (file: string) => readFileSync(new URL(`../src/client/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
describe("no form lists every client", () => {
  it("uses the search-first picker instead of a select of all accounts", () => {
    const app = read("OperationsApp.tsx");
    expect(app).not.toContain('<select name="accountId"');
    expect(app).not.toContain("function ClientAccountRootActivation(");
    expect(app).toContain("<SearchFirstPicker");
  });
});

describe("no legacy portal screens", () => {
  it("the Clients page has no portal coverage card or legacy exceptions screen, and nothing links to it", () => {
    expect(existsSync(new URL("../src/client/ClientPortalBootstrap.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../src/client/ClientPortalBootstrap.css", import.meta.url))).toBe(false);
    const sources = ["ClientHub.tsx", "OperationsApp.tsx"].map(read).join(" ");
    for (const text of ["ClientPortalBootstrap", "Portal workspace coverage", "Review legacy exceptions", "#client-portal-setup", "canManagePortalSetup"])
      expect(sources).not.toContain(text);
  });
});
