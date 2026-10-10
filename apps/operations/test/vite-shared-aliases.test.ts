import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sharedAliases } from "../vite.config";

const exportedImports = [
  "@ltds/shared/authenticated-delivery-authority",
  "@ltds/shared/verified-recipient-delivery-authority",
  "@ltds/shared/api-v2-portal-publication-proof",
  "@ltds/shared/operations-portal-workspace-publication",
  "@ltds/shared/operations-portal-native-authority",
  "@ltds/shared/operations-portal-native-delivery-authority",
] as const;

function matches(find: string | RegExp, id: string): boolean {
  return typeof find === "string" ? id === find || id.startsWith(`${find}/`) : find.test(id);
}
const portable = (value: string) => value.replaceAll("\\", "/");

describe("Operations Vite shared package aliases", () => {
  it("resolves the package root exactly without swallowing declared subpath exports", () => {
    const root = sharedAliases.find(alias => alias.find instanceof RegExp);
    expect(root?.find).toEqual(/^@ltds\/shared$/);
    expect(matches(root!.find, "@ltds/shared")).toBe(true);
    expect(matches(root!.find, "@ltds/shared/operations-portal-native-delivery-authority")).toBe(false);
    expect(portable(root!.replacement).endsWith("shared/src/index.ts")).toBe(true);
    expect(existsSync(root!.replacement)).toBe(true);
  });

  it.each(exportedImports)("maps declared export %s to its real source file", id => {
    const matchesForId = sharedAliases.filter(alias => matches(alias.find, id));
    expect(matchesForId).toHaveLength(1);
    expect(portable(matchesForId[0]!.replacement).endsWith(`${id.slice("@ltds/shared/".length)}.ts`)).toBe(true);
    expect(existsSync(matchesForId[0]!.replacement)).toBe(true);
  });
});
