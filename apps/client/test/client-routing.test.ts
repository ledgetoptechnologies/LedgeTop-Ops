import { describe, expect, it, vi } from "vitest";
import { consumeDeliveryRoute, deliveryBrowsePath, openDeliveryRoute, parseDeliveryBrowseState, parseDeliveryRoute } from "../src/client/route";

describe("delivery client routing", () => {
  it("treats the public root as an informational landing page", () => {
    expect(parseDeliveryRoute("/", "")).toEqual({ publicId: "", secret: "" });
  });

  it("reads the public id and one-time secret from a share URL", () => {
    expect(parseDeliveryRoute("/s/public-id", "#private%2Dsecret")).toEqual({
      publicId: "public-id",
      secret: "private-secret",
    });
  });

  it("preserves base64url share credentials exactly", () => {
    expect(parseDeliveryRoute(
      "/s/c2vTHqUS6Jt2rwcnuBt0mA",
      "#K-jx0eKEK9mK1cDBIWLxnWUCtw7FQrm9DnjzGB6MANI",
    )).toEqual({
      publicId: "c2vTHqUS6Jt2rwcnuBt0mA",
      secret: "K-jx0eKEK9mK1cDBIWLxnWUCtw7FQrm9DnjzGB6MANI",
    });
  });

  it("keeps legacy token links working", () => {
    const legacyToken = "a".repeat(43);
    expect(parseDeliveryRoute(`/s/${legacyToken}`, "")).toEqual({
      publicId: legacyToken,
      secret: legacyToken,
    });
  });

  it("does not interpret unrelated paths or malformed fragments as share credentials", () => {
    expect(parseDeliveryRoute("/unrelated/path", "#%zz")).toEqual({ publicId: "", secret: "" });
    expect(parseDeliveryRoute("/s/public-id/extra", "#private-secret")).toEqual({ publicId: "", secret: "" });
  });

  it("removes a staff or delegated bearer fragment synchronously while preserving query state", () => {
    const replaceState = vi.fn();
    expect(consumeDeliveryRoute(
      { pathname: "/s/public-id", search: "?folder=opaque", hash: "#private-secret" } as Location,
      { state: { key: 1 }, replaceState } as unknown as History,
    )).toEqual({ publicId: "public-id", secret: "private-secret" });
    expect(replaceState).toHaveBeenCalledWith({ key: 1 }, "", "/s/public-id?folder=opaque");

    replaceState.mockClear();
    expect(consumeDeliveryRoute(
      { pathname: "/client-share/client-id", search: "", hash: "#client-secret" } as Location,
      { state: null, replaceState } as unknown as History,
      "client-delegated",
    )).toEqual({ publicId: "client-id", secret: "client-secret" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/client-share/client-id");
  });

  it("round-trips only opaque folder/file references and the selected view", () => {
    const path = deliveryBrowsePath("public-id", { folderId: "folder_ref-1", fileId: "file_ref-2", view: "list" });
    expect(path).toBe("/s/public-id?folder=folder_ref-1&file=file_ref-2&view=list");
    expect(parseDeliveryBrowseState("?folder=folder_ref-1&file=file_ref-2&view=list")).toEqual({ folderId: "folder_ref-1", fileId: "file_ref-2", view: "list" });
    expect(path).not.toContain("#");
  });

  it("fails closed for malformed browse state without carrying unrelated query data", () => {
    expect(parseDeliveryBrowseState("?folder=../secret&file=raw/path&view=table&redirect=https://example.com", "grid"))
      .toEqual({ folderId: "", fileId: "", view: "grid" });
  });

  it("does not canonicalize a fragment link until its manifest loads", async () => {
    const calls: string[] = [];
    const result = await openDeliveryRoute(
      { publicId: "public-id", secret: "private-secret" },
      {
        createSession: async () => {
          calls.push("session");
          return { publicId: "canonical-id", canonicalPath: "/s/canonical-id" };
        },
        loadManifest: async publicId => { calls.push(`manifest:${publicId}`); },
      },
    );

    expect(calls).toEqual(["session", "manifest:canonical-id"]);
    expect(result).toEqual({ publicId: "canonical-id", canonicalPath: "/s/canonical-id" });
  });

  it("keeps the fragment exchange recoverable when manifest loading fails", async () => {
    await expect(openDeliveryRoute(
      { publicId: "public-id", secret: "private-secret" },
      {
        createSession: async () => ({ publicId: "canonical-id", canonicalPath: "/s/canonical-id" }),
        loadManifest: async () => { throw new Error("manifest unavailable"); },
      },
    )).rejects.toThrow("manifest unavailable");
  });
});
