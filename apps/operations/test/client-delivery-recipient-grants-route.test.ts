import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerClientDeliveryRecipientGrantRoutes } from "../src/worker/client-delivery-recipient-grants";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal = { id: "staff-1", email: "staff@example.test", displayName: "Staff", accessSubject: "subject-1" } as StaffPrincipal;

describe("direct client folder grant route safety gate", () => {
  it("fails closed before resolving or mutating a grant while creation is paused", async () => {
    const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
    app.use("*", async (c, next) => {
      c.set("principal", principal);
      c.set("administrator", false);
      await next();
    });
    registerClientDeliveryRecipientGrantRoutes(app);

    const env = { AUTHENTICATED_DELIVERY_CREATION_ENABLED: "false" } as unknown as Env;
    const response = await app.request("/api/delivery/client-recipients/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "paused-create-key-0001" },
      body: JSON.stringify({
        folderRef: "Sm9icy9DbGllbnRzL0FjbWU",
        recipientId: "recipient-1",
        recipientVersion: "crv_" + "a".repeat(43),
        audience: "all_members",
        expiresAt: null,
        previewVersion: "cpv_" + "b".repeat(43),
      }),
    }, env);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("New Client Workspace access is temporarily paused");
  });
});
