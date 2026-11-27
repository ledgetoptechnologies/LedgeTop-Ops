import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextShareMethod, SHARE_METHODS } from "../src/client/ShareMethodTabs";

describe("share method tabs", () => {
  it("lists Client Workspace first, then Public link", () => {
    expect(SHARE_METHODS.map(item => [item.mode, item.label])).toEqual([["workspace", "Client Workspace"], ["public", "Public link"]]);
  });
  it("moves with arrows, Home and End, skipping a disabled method", () => {
    const both = { workspace: true, public: true };
    expect(nextShareMethod("workspace", "ArrowRight", both)).toBe("public");
    expect(nextShareMethod("public", "ArrowRight", both)).toBe("workspace");
    expect(nextShareMethod("workspace", "ArrowLeft", both)).toBe("public");
    expect(nextShareMethod("public", "Home", both)).toBe("workspace");
    expect(nextShareMethod("workspace", "End", both)).toBe("public");
    expect(nextShareMethod("public", "ArrowRight", { workspace: false, public: true })).toBe("public");
    expect(nextShareMethod("workspace", "End", { workspace: true, public: false })).toBe("workspace");
    expect(nextShareMethod("workspace", "Enter", both)).toBeNull();
  });
});

const read = (file: string) => readFileSync(new URL(`../src/client/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
describe("one Share dialog for files, folders and models", () => {
  it("both dialogs use the shared tabs and panel, with no copies of their own", () => {
    for (const file of ["OperationsApp.tsx", "ViewerQuickShare.tsx"]) {
      const source = read(file);
      expect(source).toContain("<ShareMethodTabs");
      expect(source).toContain("<ShareMethodPanel");
      expect(source).not.toContain('aria-label="Sharing method"');
      expect(source).not.toMatch(/id="(share-mode|viewer-share)-(tab|panel)-/);
    }
  });
  it("Client Workspace is the default wherever it is available", () => {
    expect(read("OperationsApp.tsx")).not.toContain('useState<"public" | "workspace">("public")');
  });
  it("has no explanatory blurbs under the tabs", () => {
    const sources = read("OperationsApp.tsx") + read("ViewerQuickShare.tsx");
    for (const blurb of ["Authenticated Client Workspace access", "Choose an exact individual, a department, or an organization",
      "Create a bearer link for anyone", "Create a link for anyone who receives", "They'll see it in their Ledge Top portal",
      "share-mode-description"]) expect(sources).not.toContain(blurb);
  });
});
