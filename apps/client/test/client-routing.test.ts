import { describe, expect, it } from "vitest";
import { openDeliveryRoute, parseDeliveryRoute } from "../src/client/route";

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
