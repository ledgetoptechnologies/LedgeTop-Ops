import { describe, expect, it, vi } from "vitest";
vi.mock("../src/worker/client-portal/workspace-v2", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/client-portal/workspace-v2")>(),
  listPortalWorkspaces: vi.fn(async () => []),
}));
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import type { ClientPortalRepository } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

describe("workspace-free route admission", () => {
  it("mounts before ambient workspace admission without creating a legacy session", async () => {
    const resolveSession = vi.fn(async () => { throw Error("Ambient admission must not run"); });
    const router = createClientPortalRouter({
      resolvePrincipal: async () => ({ issuer: "issuer", subject: "subject", email: "client@example.com" }),
      repository: { resolveSession } as unknown as ClientPortalRepository,
    });
    const response = await router.request("https://client.example/request-services", {}, {
      CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_ORIGIN: "https://client.example",
    } as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ services: [], unavailable: [] });
    expect(resolveSession).not.toHaveBeenCalled();
  });
});
