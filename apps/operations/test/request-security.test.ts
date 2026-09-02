import { describe, expect, it, vi } from "vitest";
import { csrfToken, requireMutationSecurity } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = {
  id: "staff-one",
  email: "staff@example.test",
  displayName: "Staff One",
  accessSubject: "access-subject-one",
  projectAlphaUserId: null,
};

describe("Operations mutation origin security", () => {
  it("accepts the current request origin on either reviewed Operations domain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T18:00:00Z"));
    const env = {
      ENVIRONMENT: "production",
      EXPECTED_HOST: "ops.drone.example",
      OPERATIONS_ORIGINS: "https://ops.drone.example,https://ops.technology.example",
      OPERATIONS_SESSION_SECRET: "operations-session-secret-that-is-long-enough",
    } as Env;
    const token = await csrfToken(env, principal);
    for (const origin of ["https://ops.drone.example", "https://ops.technology.example"]) {
      const request = new Request(`${origin}/api/projects`, { method: "POST", headers: { Origin: origin, "X-CSRF-Token": token } });
      await expect(requireMutationSecurity(request, env, principal)).resolves.toBeUndefined();
    }
    vi.useRealTimers();
  });

  it("rejects a cross-origin header or an unreviewed request host", async () => {
    const env = {
      ENVIRONMENT: "production",
      EXPECTED_HOST: "ops.drone.example",
      OPERATIONS_ORIGINS: "https://ops.drone.example,https://ops.technology.example",
      OPERATIONS_SESSION_SECRET: "operations-session-secret-that-is-long-enough",
    } as Env;
    const token = await csrfToken(env, principal);
    await expect(requireMutationSecurity(new Request("https://ops.technology.example/api/projects", {
      method: "POST", headers: { Origin: "https://ops.drone.example", "X-CSRF-Token": token },
    }), env, principal)).rejects.toMatchObject({ status: 403 });
    await expect(requireMutationSecurity(new Request("https://ops.evil.example/api/projects", {
      method: "POST", headers: { Origin: "https://ops.evil.example", "X-CSRF-Token": token },
    }), env, principal)).rejects.toMatchObject({ status: 403 });
  });
});
