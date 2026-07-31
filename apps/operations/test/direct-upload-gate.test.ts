import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

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

  it("also gates nested part and completion routes", async () => {
    const app = new Hono();
    registerR2CrudRoutes(app as never);

    for (const path of [
      "/api/delivery/uploads/session/parts/1/ticket",
      "/api/delivery/uploads/session/complete",
    ]) {
      const response = await app.request(path, { method: "POST" }, { DIRECT_DELIVERY_UPLOADS_ENABLED: "false" });
      expect(response.status).toBe(503);
    }
  });
});
