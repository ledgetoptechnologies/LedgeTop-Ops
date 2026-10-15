import { describe, expect, it } from "vitest";
import { configuredDeploymentOrigin } from "@ltds/shared/configured-deployment-origin";

const base = { environment: "production", origin: "https://ops.example.com", expectedHost: "ops.example.com" };

describe("configured deployment origin admission", () => {
  it.each(["staging", "production"])("accepts an exact server-configured %s deployment", environment => {
    expect(configuredDeploymentOrigin({ ...base, environment })).toBe(base.origin);
  });

  it.each(["", "Production", "STAGING", "preview", "development", "local", "test", " production"])(
    "rejects unrecognized environment %j", environment => {
      expect(configuredDeploymentOrigin({ ...base, environment })).toBeNull();
    });

  it.each([
    undefined, "", "ops.example.com", "http://ops.example.com", "https://ops.example.com/",
    "https://ops.example.com/path", "https://ops.example.com?environment=production",
    "https://ops.example.com#production", "https://user@ops.example.com",
    "https://user:password@ops.example.com", "https://ops.example.com:443",
    "https://ops.example.com:8443", "https://OPS.example.com", " https://ops.example.com",
    "https://ops.example.com ", "https://ops.example.com.", "https://ops.example.com.evil.example",
    "https://ops-example.com", "https://evil.example/ops.example.com",
  ])("rejects noncanonical or mismatched configured origin %j", origin => {
    expect(configuredDeploymentOrigin({ ...base, origin })).toBeNull();
  });

  it.each([undefined, "", "OPS.example.com", "ops.example.com.", "ops.example.com:443", "other.example.com"])(
    "requires the exact configured expected host %j", expectedHost => {
      expect(configuredDeploymentOrigin({ ...base, expectedHost })).toBeNull();
    });

  it.each(["localhost", "foo.localhost", "127.0.0.1", "127.1.2.3", "0.0.0.0", "[::1]"])(
    "rejects production local listener %s even when configuration agrees", expectedHost => {
      expect(configuredDeploymentOrigin({ ...base, origin: `https://${expectedHost}`, expectedHost })).toBeNull();
    });

  it("does not use a staging-looking hostname to select environment", () => {
    const configured = { origin: "https://staging.ops.example.com", expectedHost: "staging.ops.example.com" };
    expect(configuredDeploymentOrigin({ ...configured, environment: "production" })).toBe(configured.origin);
    expect(configuredDeploymentOrigin({ ...configured, environment: "preview" })).toBeNull();
  });

  it("requires canonical punycode configuration rather than silently normalizing a Unicode hostname", () => {
    const canonical = "xn--bcher-kva.example";
    expect(configuredDeploymentOrigin({ ...base, origin: "https://bücher.example", expectedHost: canonical })).toBeNull();
    expect(configuredDeploymentOrigin({ ...base, origin: `https://${canonical}`, expectedHost: canonical }))
      .toBe(`https://${canonical}`);
  });
});
