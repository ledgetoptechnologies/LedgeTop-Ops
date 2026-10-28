import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("jose", async () => ({
  ...await vi.importActual<typeof import("jose")>("jose"),
  createRemoteJWKSet: calls.create,
}));

import { accessJwksResolver } from "../src/worker/access-jwks";

describe("Cloudflare Access JWKS resolver reuse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.create.mockImplementation((url: URL) => ({ jwksUrl: url.href }));
  });

  it("reuses a resolver for the same normalized issuer", () => {
    const first = accessJwksResolver("https://same-team.cloudflareaccess.com");
    const second = accessJwksResolver("https://same-team.cloudflareaccess.com/");

    expect(second).toBe(first);
    expect(calls.create).toHaveBeenCalledTimes(1);
    expect(calls.create).toHaveBeenCalledWith(new URL("https://same-team.cloudflareaccess.com/cdn-cgi/access/certs"));
  });

  it("keeps different issuers isolated", () => {
    const first = accessJwksResolver("https://first-team.cloudflareaccess.com");
    const second = accessJwksResolver("https://second-team.cloudflareaccess.com");

    expect(second).not.toBe(first);
    expect(calls.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://team.cloudflareaccess.com",
    "https://user:pass@team.cloudflareaccess.com",
    "https://team.cloudflareaccess.com/path",
    "https://team.cloudflareaccess.com/?issuer=other",
  ])("rejects noncanonical issuer input %s", issuer => {
    expect(() => accessJwksResolver(issuer)).toThrow("access_jwks_issuer_invalid");
    expect(calls.create).not.toHaveBeenCalled();
  });
});
