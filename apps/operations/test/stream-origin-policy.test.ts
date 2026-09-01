import { describe, expect, it } from "vitest";
import { streamAllowedOriginHosts } from "../src/worker/file-events";

describe("Cloudflare Stream portal origins", () => {
  it("keeps the canonical portal and adds the reviewed secondary presentation host", () => {
    expect(streamAllowedOriginHosts({
      DELIVERY_BASE_URL: "https://client.ledgetopdroneservices.com",
      CLIENT_PORTAL_ORIGINS: "https://client.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com",
    })).toEqual(["client.ledgetopdroneservices.com", "portal.ledgetoptechnologies.com"]);
  });

  it("keeps single-origin deployments compatible", () => {
    expect(streamAllowedOriginHosts({ DELIVERY_BASE_URL: "https://client.example.test" }))
      .toEqual(["client.example.test"]);
  });

  it.each([
    "https://client.technology.example",
    "https://client.drone.example,https://client.drone.example",
    "https://client.drone.example,http://client.technology.example",
    "https://client.drone.example,",
  ])("rejects an unsafe or incomplete origin list: %s", CLIENT_PORTAL_ORIGINS => {
    expect(() => streamAllowedOriginHosts({
      DELIVERY_BASE_URL: "https://client.drone.example",
      CLIENT_PORTAL_ORIGINS,
    })).toThrow("stream-allowed-origins-invalid");
  });
});
