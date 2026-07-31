import { describe, expect, it } from "vitest";
import {
  DIRECT_DELIVERY_UPLOADS_DISABLED_CODE,
  directDeliveryUploadsCapability,
} from "../src/worker/direct-upload-policy";

describe("direct delivery upload capability", () => {
  it("fails closed and requires the exact true value", () => {
    expect(directDeliveryUploadsCapability({})).toEqual({ enabled: false, reason: "disabled" });
    expect(directDeliveryUploadsCapability({ DIRECT_DELIVERY_UPLOADS_ENABLED: "false" }))
      .toEqual({ enabled: false, reason: "disabled" });
    expect(directDeliveryUploadsCapability({ DIRECT_DELIVERY_UPLOADS_ENABLED: "TRUE" }))
      .toEqual({ enabled: false, reason: "disabled" });
    expect(directDeliveryUploadsCapability({ DIRECT_DELIVERY_UPLOADS_ENABLED: "true" }))
      .toEqual({ enabled: true, reason: "available" });
    expect(DIRECT_DELIVERY_UPLOADS_DISABLED_CODE).toBe("direct_delivery_uploads_disabled");
  });
});
