import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ jwks: vi.fn(), verify: vi.fn(), resolve: vi.fn() }));

vi.mock("jose", () => ({
  createRemoteJWKSet: calls.jwks,
  jwtVerify: calls.verify,
}));
vi.mock("../src/worker/native-staff-identity", () => ({
  resolveNativeStaffIdentityWithAdmissionVersion: calls.resolve,
}));

import { authenticateNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "../src/worker/native-staff-auth";

const issuer = "https://synthetic-team.cloudflareaccess.com";
const staffAudience = "staff-audience-value";
const configuration: NativeStaffAccessConfiguration = { enabled: true, issuer, staffAudience };
const request = new Request("https://ops.example.test/api/admin/acceptance", {
  headers: { "Cf-Access-Jwt-Assertion": "synthetic.assertion" },
});
const identity = Object.freeze({ kind: "native" as const, staffId: "staff-1",
  verifiedAccessSubject: "provider|staff-1", email: "staff@example.test",
  displayName: "Staff", profileVersion: 3 });

function payload(aud: string | string[]) {
  const now = Math.floor(Date.now() / 1000);
  return { aud, type: "app", sub: identity.verifiedAccessSubject, email: identity.email,
    iat: now - 1, exp: now + 300 };
}

describe("native staff Access assertion authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.jwks.mockReturnValue("synthetic-jwks");
    calls.resolve.mockResolvedValue({ identity, admissionVersion: 7 });
  });

  it("accepts a valid staff-only Access configuration and exact staff assertion", async () => {
    calls.verify.mockResolvedValue({ payload: payload(staffAudience) });

    await expect(authenticateNativeStaffWithAdmissionVersion(request, {} as D1Database, configuration))
      .resolves.toMatchObject({ identity, admissionVersion: 7 });
    expect(calls.verify).toHaveBeenCalledWith("synthetic.assertion", "synthetic-jwks", {
      issuer, audience: staffAudience, algorithms: ["RS256"],
    });
    expect(calls.resolve).toHaveBeenCalledWith(expect.anything(), {
      verifiedEmail: identity.email, verifiedAccessSubject: identity.verifiedAccessSubject,
    });
  });

  it.each([
    ["a different audience", "other-staff-audience"],
    ["a multi-audience assertion", [staffAudience, "other-staff-audience"]],
  ])("rejects %s before resolving a native admission", async (_label, aud) => {
    calls.verify.mockResolvedValue({ payload: payload(aud) });

    await expect(authenticateNativeStaffWithAdmissionVersion(request, {} as D1Database, configuration))
      .rejects.toThrow("native_staff_access_denied");
    expect(calls.resolve).not.toHaveBeenCalled();
  });
});
