import { describe, expect, it, vi } from "vitest";
import { dispatchNextOperationsPortalNativeDeliveryAuthority }
  from "../src/worker/operations-portal-native-delivery-authority-dispatch";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

function database(action: "delivery.grant" | "delivery.revoke") {
  const releases: unknown[][] = [];
  const prepare = vi.fn((sql: string) => ({ bind: (...values: unknown[]) => ({
    first: async () => {
      if (sql.startsWith("SELECT 1 FROM operations_portal_native_delivery_authority_receipts")) return null;
      if (sql.includes("SELECT outbox.operation_id,command.action")) return { operation_id: id(1), action,
        request_fingerprint: "a".repeat(64), canonical_wire_json: "{}", state: "dispatching",
        attempt_count: 1, claim_token: id(2) };
      return null;
    },
    run: async () => {
      if (sql.includes("SET state='dispatching'")) return { meta: { changes: 1 } };
      if (sql.includes("SET state=?")) releases.push(values);
      return { meta: { changes: 1 } };
    },
  }) }));
  return { value: { withSession: () => ({ prepare }) } as unknown as D1Database, releases };
}

describe("operations native delivery dispatch recovery", () => {
  it("never dead-letters a committed revoke whose stored wire cannot be parsed", async () => {
    const fake = database("delivery.revoke"), apply = vi.fn(), status = vi.fn();
    await expect(dispatchNextOperationsPortalNativeDeliveryAuthority({ database: fake.value, operationId: id(1),
      binding: { applyNativeDeliveryAuthority: apply, getNativeDeliveryAuthorityStatus: status } }))
      .resolves.toEqual({ operationId: id(1), state: "retry" });
    expect(fake.releases[0]?.[0]).toBe("retry");
    expect(apply).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("can terminally deny a malformed grant without calling Client", async () => {
    const fake = database("delivery.grant"), apply = vi.fn(), status = vi.fn();
    await expect(dispatchNextOperationsPortalNativeDeliveryAuthority({ database: fake.value, operationId: id(1),
      binding: { applyNativeDeliveryAuthority: apply, getNativeDeliveryAuthorityStatus: status } }))
      .resolves.toEqual({ operationId: id(1), state: "dead" });
    expect(fake.releases[0]?.[0]).toBe("dead");
    expect(apply).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
