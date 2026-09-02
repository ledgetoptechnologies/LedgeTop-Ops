import { describe, expect, it } from "vitest";
import { streamAllowedOriginHosts } from "../src/worker/file-events";

describe("Cloudflare Stream portal origins", () => {
  it("keeps both canonical portals and the legacy compatibility host", () => {
    expect(streamAllowedOriginHosts({
      DELIVERY_BASE_URL: "https://portal.ledgetopdroneservices.com",
      CLIENT_PORTAL_ORIGINS: "https://portal.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com,https://client.ledgetopdroneservices.com",
    })).toEqual(["portal.ledgetopdroneservices.com", "portal.ledgetoptechnologies.com", "client.ledgetopdroneservices.com"]);
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
