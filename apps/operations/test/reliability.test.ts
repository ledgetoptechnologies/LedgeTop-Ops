import { describe, expect, it } from "vitest";
import { aliasParent, normalizeAliasKey, validateDisplayName } from "../src/worker/aliases";
import { hidden } from "../src/worker/file-events";
import { derivativePrefixes, validateDeleteConfirmation } from "../src/worker/source-delete";
import { artifactDirectory, previewIdentity } from "../src/worker/artifacts";
import { tombstoneMatches } from "../src/worker/trash";

describe("delivery reliability controls", () => {
  it("rejects reserved segments everywhere in Operations paths", () => {
    for (const key of ["_ltds/a.jpg", "jobs/_ltds/a.jpg", "jobs/client/dump/a.jpg", "jobs/dump/client/a.jpg"]) expect(hidden(key)).toBe(true);
    expect(hidden("jobs/client/unedited/a.jpg")).toBe(false);
  });

  it("validates aliases without allowing hierarchy or control spoofing", () => {
    expect(validateDisplayName(" Client-facing name ")).toBe("Client-facing name");
    expect(() => validateDisplayName("folder/name")).toThrow();
    expect(() => validateDisplayName("..")) .toThrow();
    expect(() => validateDisplayName("bad\nname")).toThrow();
    for (const name of ["CON", "client?.jpg", "folder.", "_ltds", "dump"]) expect(() => validateDisplayName(name)).toThrow();
    expect(() => normalizeAliasKey("jobs/client/dump/")) .toThrow();
    expect(aliasParent("jobs/client/photo.jpg")).toBe("jobs/client/");
    expect(aliasParent("jobs/client/edited/")).toBe("jobs/client/");
  });

  it("targets only the deterministic sibling derivative namespace", async () => {
    const prefixes = await derivativePrefixes("Jobs/client/photo.jpg", false);
    expect(prefixes).toHaveLength(1);
    expect(prefixes[0]).toMatch(/^Jobs\/client\/_ltds\/previews\/[a-f0-9]{64}\/$/);
    await expect(derivativePrefixes("Jobs/client/edited/", true)).resolves.toEqual([]);
  });

  it("uses the NFC filename, not the client path, as preview identity", async () => {
    await expect(previewIdentity("Jobs/A/cafe\u0301.JPG")).resolves.toBe(await previewIdentity("Jobs/B/café.JPG"));
    await expect(artifactDirectory("Jobs/A/photo.jpg")).resolves.toMatch(/^Jobs\/A\/_ltds\/previews\/[a-f0-9]{64}\/$/);
  });

  it("requires an exact typed-name delete confirmation", () => {
    expect(() => validateDeleteConfirmation("folder", "folder")).not.toThrow();
    expect(() => validateDeleteConfirmation("Folder", "folder")).toThrow();
    expect(() => validateDeleteConfirmation("folder ", "folder")).toThrow();
  });

  it("matches trash tombstones without crossing folder boundaries", () => {
    expect(tombstoneMatches({ physical_key: "Jobs/client/photo.jpg", tombstone_kind: "exact" }, "Jobs/client/photo.jpg")).toBe(true);
    expect(tombstoneMatches({ physical_key: "Jobs/client/photo.jpg", tombstone_kind: "exact" }, "Jobs/client/photo.jpg.bak")).toBe(false);
    expect(tombstoneMatches({ physical_key: "Jobs/client/", tombstone_kind: "prefix" }, "Jobs/client/edited/photo.jpg")).toBe(true);
    expect(tombstoneMatches({ physical_key: "Jobs/client/", tombstone_kind: "prefix" }, "Jobs/client-old/photo.jpg")).toBe(false);
  });
});
