import { describe, expect, it } from "vitest";
import { streamAllowedOriginHosts } from "../src/worker/file-events";

describe("Cloudflare Stream playback origins", () => {
  it("allows the canonical portal/share hosts and only the legacy public-share hosts", () => {
    expect(streamAllowedOriginHosts({
      DELIVERY_BASE_URL: "https://portal.ledgetop.app",
      PUBLIC_SHARE_ORIGIN: "https://delivery.ledgetop.app",
      LEGACY_CLIENT_ORIGINS: "https://portal.ledgetopdroneservices.com,https://client.ledgetopdroneservices.com",
    })).toEqual(["portal.ledgetop.app", "delivery.ledgetop.app", "portal.ledgetopdroneservices.com", "client.ledgetopdroneservices.com"]);
  });

  it("keeps single-origin deployments compatible", () => {
    expect(streamAllowedOriginHosts({ DELIVERY_BASE_URL: "https://client.example.test" }))
      .toEqual(["client.example.test"]);
  });

  it.each([
    "https://client.drone.example,https://client.drone.example",
    "https://client.drone.example,http://portal.technology.example",
    "https://client.drone.example,",
  ])("rejects an unsafe or incomplete origin list: %s", LEGACY_CLIENT_ORIGINS => {
    expect(() => streamAllowedOriginHosts({
      DELIVERY_BASE_URL: "https://client.drone.example",
      PUBLIC_SHARE_ORIGIN: "https://share.drone.example",
      LEGACY_CLIENT_ORIGINS,
    })).toThrow("stream-allowed-origins-invalid");
  });

  it("rejects duplicate canonical and legacy origins", () => {
    expect(() => streamAllowedOriginHosts({
      DELIVERY_BASE_URL: "https://portal.example.test",
      PUBLIC_SHARE_ORIGIN: "https://share.example.test",
      LEGACY_CLIENT_ORIGINS: "https://portal.example.test",
    })).toThrow("stream-allowed-origins-invalid");
  });
});
