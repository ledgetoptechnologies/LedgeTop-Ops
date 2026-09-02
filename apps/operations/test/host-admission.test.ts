import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
}));
import { requestHostAllowed } from "../src/worker/host-admission";

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
});
