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
});
