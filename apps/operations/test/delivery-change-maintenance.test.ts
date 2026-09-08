import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/worker/authenticated-delivery-change-notifications", () => ({
  processAuthenticatedDeliveryChangeNotifications: vi.fn(async () => 7),
}));
vi.mock("../src/worker/delivery-change-projector", () => ({
  projectAuthenticatedDeliveryChanges: vi.fn(async () => ({ claimed: 0, completed: 0, suppressed: 0, retried: 0, failed: 0 })),
}));
vi.mock("../src/worker/authenticated-delivery-bell", () => ({
  publishAuthenticatedDeliveryChangeBells: vi.fn(async () => 3),
}));

import { processAuthenticatedDeliveryChangeNotifications } from "../src/worker/authenticated-delivery-change-notifications";
import { projectAuthenticatedDeliveryChanges } from "../src/worker/delivery-change-projector";
import { publishAuthenticatedDeliveryChangeBells } from "../src/worker/authenticated-delivery-bell";
import { maintainAuthenticatedDeliveryChanges } from "../src/worker/delivery-change-maintenance";
import type { Env } from "../src/worker/types";

describe("delivery-change scheduled maintenance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("awaits recovery and bell publication before sending existing ready batches", async () => {
    const order: string[] = [];
    vi.mocked(projectAuthenticatedDeliveryChanges).mockImplementationOnce(async () => {
      await Promise.resolve();
      order.push("recovered");
      return { claimed: 0, completed: 0, suppressed: 0, retried: 0, failed: 0 };
    });
    vi.mocked(publishAuthenticatedDeliveryChangeBells).mockImplementationOnce(async () => {
      order.push("published");
      return 3;
    });
    vi.mocked(processAuthenticatedDeliveryChangeNotifications).mockImplementationOnce(async () => {
      order.push("sent");
      return 7;
    });
    const env = {} as Env;
    expect(await maintainAuthenticatedDeliveryChanges(env)).toBe(7);
    expect(order).toEqual(["recovered", "published", "sent"]);
    expect(projectAuthenticatedDeliveryChanges).toHaveBeenCalledWith(env);
    expect(publishAuthenticatedDeliveryChangeBells).toHaveBeenCalledWith(env);
    expect(processAuthenticatedDeliveryChangeNotifications).toHaveBeenCalledWith(env);
  });

  it("keeps an idle recovery pass quiet and still dispatches mail", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await maintainAuthenticatedDeliveryChanges({} as Env)).toBe(7);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("logs only aggregate results when work is performed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(projectAuthenticatedDeliveryChanges).mockResolvedValueOnce({ claimed: 2, completed: 1, suppressed: 0, retried: 1, failed: 0 });
    try {
      await maintainAuthenticatedDeliveryChanges({} as Env);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "delivery_change.recovery.tick", claimed: 2, completed: 1, suppressed: 0, retried: 1, failed: 0 }));
    } finally { log.mockRestore(); }
  });

  it("does not send after a recovery infrastructure failure or expose private errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(projectAuthenticatedDeliveryChanges).mockRejectedValueOnce(new Error("private-source-key-and-recipient"));
    try {
      await expect(maintainAuthenticatedDeliveryChanges({} as Env)).rejects.toThrow("Delivery change recovery failed");
      expect(processAuthenticatedDeliveryChangeNotifications).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "delivery_change.recovery.error" }));
    } finally { log.mockRestore(); }
  });

  it("does not send after bell publication fails or expose its private database error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(publishAuthenticatedDeliveryChangeBells).mockRejectedValueOnce(new Error("private-source-key-and-recipient"));
    try {
      await expect(maintainAuthenticatedDeliveryChanges({} as Env)).rejects.toThrow("Delivery change bell publication failed");
      expect(processAuthenticatedDeliveryChangeNotifications).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "delivery_change.bell.error" }));
    } finally { log.mockRestore(); }
  });
});
