import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

import { registerR2CrudRoutes } from "../src/worker/r2-crud";

describe("direct delivery upload route gate", () => {
  it("fails closed before touching delivery storage or upload-session state", async () => {
    const app = new Hono();
    registerR2CrudRoutes(app as never);

    const response = await app.request(
      "/api/delivery/uploads",
      { method: "POST", body: "{}" },
      { DIRECT_DELIVERY_UPLOADS_ENABLED: "false" },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "direct_delivery_uploads_disabled",
      message: "Direct delivery uploads are currently disabled",
    });
  });

  it("gates ticket issuance but leaves existing-session lifecycle routes available", async () => {
    const app = new Hono();
    registerR2CrudRoutes(app as never);

    const ticket = await app.request("/api/delivery/uploads/session/parts/1/ticket", { method: "POST" }, { DIRECT_DELIVERY_UPLOADS_ENABLED: "false" });
    expect(ticket.status).toBe(503);

    const missingDatabase = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
    const lifecycleEnv = { DIRECT_DELIVERY_UPLOADS_ENABLED: "false", OPS_DB: missingDatabase };
    const status = await app.request("/api/delivery/uploads/session", { method: "GET" }, lifecycleEnv);
    const completion = await app.request("/api/delivery/uploads/session/complete", { method: "POST", body: "{}" }, lifecycleEnv);
    expect(status.status).toBe(500);
    expect(completion.status).toBe(500);
  });
});
