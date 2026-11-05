import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
}));
import { admittedOperationsRequestOrigin, requestHostAllowed } from "../src/worker/host-admission";

describe("Operations deployed host admission", () => {
  it.each(["production", "staging"] as const)("requires the exact configured host in %s", (ENVIRONMENT) => {
    const env = { ENVIRONMENT, EXPECTED_HOST: "ops.example" };
    expect(requestHostAllowed("https://ops.example/health", env)).toBe(true);
    expect(requestHostAllowed("https://ops.example.evil.test/health", env)).toBe(false);
    expect(requestHostAllowed("https://wrong.example/health", env)).toBe(false);
  });

  it("allows local development hosts", () => {
    expect(requestHostAllowed("http://127.0.0.1:8788/health", { ENVIRONMENT: "development", EXPECTED_HOST: "ops.example" })).toBe(true);
  });

  it.each(["production", "staging"] as const)("admits both exact reviewed Operations origins in %s", (ENVIRONMENT) => {
    const env = { ENVIRONMENT, EXPECTED_HOST: "ops.drone.example", OPERATIONS_ORIGINS: "https://ops.drone.example,https://ops.technology.example" };
    expect(requestHostAllowed("https://ops.drone.example/clients", env)).toBe(true);
    expect(requestHostAllowed("https://ops.technology.example/clients", env)).toBe(true);
    expect(requestHostAllowed("https://ops.technology.example.evil.test/clients", env)).toBe(false);
  });

  it("fails closed on malformed, duplicate, insecure, or incomplete Operations origins", () => {
    const base = { ENVIRONMENT: "production" as const, EXPECTED_HOST: "ops.drone.example" };
    for (const OPERATIONS_ORIGINS of [
      "https://ops.technology.example",
      "https://ops.drone.example,https://ops.drone.example",
      "https://ops.drone.example,http://ops.technology.example",
      "https://ops.drone.example,",
    ]) expect(requestHostAllowed("https://ops.drone.example/health", { ...base, OPERATIONS_ORIGINS })).toBe(false);
  });

  it("resolves only configured Ops origins for origin-bound API checks", () => {
    const env = { ENVIRONMENT: "production" as const, EXPECTED_HOST: "ops.ledgetop.app",
      OPERATIONS_ORIGINS: "https://ops.ledgetop.app" };
    const canonical = "https://ops.ledgetop.app";
    expect(admittedOperationsRequestOrigin(`${canonical}/api/session`, env, canonical)).toBe(canonical);
    expect(admittedOperationsRequestOrigin("https://ops.ledgetopdroneservices.com/api/session", env, canonical))
      .toBeNull();
    expect(requestHostAllowed("https://ops.ledgetopdroneservices.com/api/session", env)).toBe(false);
    for (const url of ["https://portal.ledgetop.app/api/session", "https://portal.ledgetopdroneservices.com/api/session",
      "https://ops.ledgetopdroneservices.com.evil.test/api/session", "https://unconfigured.example/api/session",
      "http://ops.ledgetopdroneservices.com/api/session"])
      expect(admittedOperationsRequestOrigin(url, env, canonical)).toBeNull();
    expect(admittedOperationsRequestOrigin("https://ops.ledgetopdroneservices.com/api/session",
      { ...env, OPERATIONS_ORIGINS: "https://ops.ledgetop.app" }, canonical)).toBeNull();
    expect(admittedOperationsRequestOrigin("https://portal.ledgetop.app/api/session",
      { ...env, OPERATIONS_ORIGINS: "https://ops.ledgetop.app,https://portal.ledgetop.app" }, canonical)).toBeNull();
    expect(admittedOperationsRequestOrigin("https://ops.ledgetop.app/api/session", env,
      "https://ops.ledgetopdroneservices.com")).toBeNull();
  });

  it("honors explicitly configured production Ops origins and retires them when removed", () => {
    const env = { ENVIRONMENT: "production" as const, EXPECTED_HOST: "ops.ledgetop.app",
      OPERATIONS_ORIGINS: "https://ops.ledgetop.app,https://ops.ledgetopdroneservices.com,https://ops.ledgetoptechnologies.com" };
    expect(requestHostAllowed("https://ops.ledgetop.app/administration", env)).toBe(true);
    expect(requestHostAllowed("https://ops.ledgetopdroneservices.com/api/session", env)).toBe(true);
    expect(requestHostAllowed("https://ops.ledgetoptechnologies.com/api/session", env)).toBe(true);
    expect(admittedOperationsRequestOrigin("https://ops.ledgetopdroneservices.com/api/session", env,
      "https://ops.ledgetop.app")).toBe("https://ops.ledgetopdroneservices.com");
    expect(admittedOperationsRequestOrigin("https://ops.ledgetoptechnologies.com/api/session", env,
      "https://ops.ledgetop.app")).toBe("https://ops.ledgetoptechnologies.com");
    const canonicalOnly = { ...env, OPERATIONS_ORIGINS: "https://ops.ledgetop.app" };
    expect(requestHostAllowed("https://ops.ledgetopdroneservices.com/api/session", canonicalOnly)).toBe(false);
    expect(requestHostAllowed("https://ops.ledgetoptechnologies.com/api/session", canonicalOnly)).toBe(false);
    expect(admittedOperationsRequestOrigin("https://ops.ledgetopdroneservices.com/api/session", env,
      "https://ops.ledgetop.app")).toBe("https://ops.ledgetopdroneservices.com");
    expect(admittedOperationsRequestOrigin("https://ops.ledgetopdroneservices.com/api/session", canonicalOnly,
      "https://ops.ledgetop.app")).toBeNull();
  });

  it("keeps privileged API origin resolution canonical-only in development", () => {
    const env = { ENVIRONMENT: "development" as const, EXPECTED_HOST: "ops.example" };
    expect(admittedOperationsRequestOrigin("http://127.0.0.1:8788/api/session", env,
      "https://ops.example")).toBeNull();
    expect(admittedOperationsRequestOrigin("https://ops.example/api/session", env,
      "https://ops.example")).toBe("https://ops.example");
  });

  it("keeps a valid custom primary origin canonical-only and rejects portal entries", () => {
    const custom = { ENVIRONMENT: "production" as const, EXPECTED_HOST: "ops.custom.example",
      OPERATIONS_ORIGINS: "https://ops.custom.example" };
    expect(admittedOperationsRequestOrigin("https://ops.custom.example/api/session", custom,
      "https://ops.custom.example")).toBe("https://ops.custom.example");
    expect(admittedOperationsRequestOrigin("https://other.custom.example/api/session", custom,
      "https://ops.custom.example")).toBeNull();
    expect(admittedOperationsRequestOrigin("https://ops.custom.example/api/session",
      { ...custom, OPERATIONS_ORIGINS: "https://ops.custom.example,https://portal.ledgetop.app" },
      "https://ops.custom.example")).toBeNull();
  });

  it("does not admit a known Ops origin under the wrong environment", () => {
    expect(admittedOperationsRequestOrigin("https://ops-staging.ledgetopdroneservices.com/api/session",
      { ENVIRONMENT: "production", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
        OPERATIONS_ORIGINS: "https://ops-staging.ledgetopdroneservices.com" },
      "https://ops-staging.ledgetopdroneservices.com")).toBeNull();
    expect(admittedOperationsRequestOrigin("https://ops.ledgetop.app/api/session",
      { ENVIRONMENT: "staging", EXPECTED_HOST: "ops.ledgetop.app", OPERATIONS_ORIGINS: "https://ops.ledgetop.app" },
      "https://ops.ledgetop.app")).toBeNull();
    for (const host of ["client.ledgetoptechnologies.com", "portal-staging.ledgetopdroneservices.com",
      "client-staging.ledgetop.app", "delivery.ledgetopdroneservices.com"])
      expect(admittedOperationsRequestOrigin(`https://${host}/api/session`,
        { ENVIRONMENT: "production", EXPECTED_HOST: host, OPERATIONS_ORIGINS: `https://${host}` },
        `https://${host}`)).toBeNull();
  });
});
