import { describe, expect, it } from "vitest";
import { recentDeliveryLinksQuery } from "../src/client/RecentDeliveryLinks";

describe("recent delivery links query", () => {
  it("requests exact current-folder links when a folder is open", () => {
    const query = new URLSearchParams(recentDeliveryLinksQuery("Jobs/Clients/Acme/Edited/"));
    expect(Object.fromEntries(query)).toEqual({
      limit: "8",
      prefix: "Jobs/Clients/Acme/Edited/",
      folderScope: "exact",
    });
  });

  it("keeps the prefixless dashboard card global", () => {
    const query = new URLSearchParams(recentDeliveryLinksQuery());
    expect(Object.fromEntries(query)).toEqual({ limit: "8" });
    expect(query.has("folderScope")).toBe(false);
  });
});
