import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claims: {} as Record<string, unknown>,
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(),
  first: vi.fn(),
  run: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: mocks.createRemoteJWKSet,
  jwtVerify: mocks.jwtVerify,
}));

import { HTTPException } from "hono/http-exception";
import { authenticateBoundStaffForViewerRenewal } from "../src/worker/auth";
import type { Env } from "../src/worker/types";

const row = {
  id: "staff-1", email: "owner@example.test", display_name: "Owner",
  access_subject: "human-subject", project_alpha_user_id: null,
};
type StaffRow = Omit<typeof row, "access_subject"> & { access_subject: string | null };

function env(user: StaffRow | null): Env {
  mocks.prepare.mockImplementation((sql: string) => ({
    bind: (..._values: unknown[]) => ({
      first: mocks.first.mockResolvedValue(user),
      run: mocks.run,
    }),
  }));
  return {
    TEAM_DOMAIN: "https://team.cloudflareaccess.com", OPERATIONS_AUD: "ops-audience",
    OPS_DB: { prepare: mocks.prepare } as unknown as D1Database,
  } as Env;
}

describe("strict Viewer renewal staff authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claims = { type: "app", sub: "human-subject", email: "owner@example.test", exp: Math.floor(Date.now() / 1000) + 600 };
    mocks.createRemoteJWKSet.mockReturnValue({});
    mocks.jwtVerify.mockImplementation(async () => ({ payload: mocks.claims }));
    mocks.first.mockResolvedValue(row);
    mocks.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
    mocks.prepare.mockImplementation((sql: string) => ({
      bind: (..._values: unknown[]) => ({ first: mocks.first, run: mocks.run }),
    }));
  });

  it("accepts only an existing active staff-to-Access-subject binding and returns verified expiry", async () => {
    const result = await authenticateBoundStaffForViewerRenewal(new Request("https://ops.example.test/", {
      headers: { "Cf-Access-Jwt-Assertion": "signed-jwt" },
    }), env(row));
    expect(result.principal).toMatchObject({ id: row.id, accessSubject: "human-subject" });
    expect(result.expiresAt).toBe(mocks.claims.exp);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("does not first-bind an unbound account or overwrite a different binding", async () => {
    for (const access_subject of [null, "other-subject"]) {
      mocks.first.mockResolvedValue({ ...row, access_subject });
      await expect(authenticateBoundStaffForViewerRenewal(new Request("https://ops.example.test/", {
        headers: { "Cf-Access-Jwt-Assertion": "signed-jwt" },
      }), env({ ...row, access_subject }))).rejects.toMatchObject({ status: 403 });
      expect(mocks.run).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid expiry or service-token assertions before staff lookup", async () => {
    for (const exp of [undefined, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Math.floor(Date.now() / 1000) - 1]) {
      if (exp === undefined) delete mocks.claims.exp;
      else mocks.claims.exp = exp;
      await expect(authenticateBoundStaffForViewerRenewal(new Request("https://ops.example.test/", {
        headers: { "Cf-Access-Jwt-Assertion": "signed-jwt" },
      }), env(row))).rejects.toBeInstanceOf(HTTPException);
      mocks.claims.exp = Math.floor(Date.now() / 1000) + 600;
    }
    mocks.claims.common_name = "service-token";
    await expect(authenticateBoundStaffForViewerRenewal(new Request("https://ops.example.test/", {
      headers: { "Cf-Access-Jwt-Assertion": "signed-jwt" },
    }), env(row))).rejects.toBeInstanceOf(HTTPException);
    delete mocks.claims.common_name;
    mocks.claims.service_token_status = true;
    await expect(authenticateBoundStaffForViewerRenewal(new Request("https://ops.example.test/", {
      headers: { "Cf-Access-Jwt-Assertion": "signed-jwt" },
    }), env(row))).rejects.toBeInstanceOf(HTTPException);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
