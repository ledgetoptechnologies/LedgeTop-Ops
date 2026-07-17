import { describe, expect, it } from "vitest";
import { parseDeliveryRoute } from "../src/client/route";

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
});
