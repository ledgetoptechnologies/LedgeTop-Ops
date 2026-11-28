import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIENT_SEARCH_LABEL, nextActiveOption } from "../src/client/ClientSearchBox";

describe("client search box keys", () => {
  it("moves through the matches and stops at the ends", () => {
    expect(nextActiveOption(-1, "ArrowDown", 3)).toBe(0);
    expect(nextActiveOption(0, "ArrowDown", 3)).toBe(1);
    expect(nextActiveOption(2, "ArrowDown", 3)).toBe(2);
    expect(nextActiveOption(-1, "ArrowUp", 3)).toBe(2);
    expect(nextActiveOption(0, "ArrowUp", 3)).toBe(0);
    expect(nextActiveOption(1, "Home", 3)).toBe(0);
    expect(nextActiveOption(0, "End", 3)).toBe(2);
    expect(nextActiveOption(0, "ArrowDown", 0)).toBeNull();
    expect(nextActiveOption(0, "Enter", 3)).toBeNull();
  });
  it("is labelled Client in every share dialog", () => {
    expect(CLIENT_SEARCH_LABEL).toBe("Client");
  });
});

const read = (file: string) => readFileSync(new URL(`../src/client/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
describe("one client search box", () => {
  it("the Data and model Share dialogs both use the shared box, with no search box of their own", () => {
    for (const file of ["ClientSharePicker.tsx", "ViewerQuickShare.tsx"]) {
      const source = read(file);
      expect(source).toContain("<ClientSearchBox");
      expect(source).not.toContain('role="combobox"');
      expect(source).not.toContain('role="listbox"');
    }
  });
});
