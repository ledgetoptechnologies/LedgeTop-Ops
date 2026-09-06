import { describe, expect, it } from "vitest";
import {
  notificationMigrationMaintenanceActive,
  notificationMigrationMaintenanceResponse,
} from "../../client/src/worker/client-portal/notification-migration-maintenance";

describe("notification migration maintenance control", () => {
  it("is default-off and returns a retryable response only for the explicit true value", async () => {
    expect(notificationMigrationMaintenanceActive({})).toBe(false);
    expect(notificationMigrationMaintenanceActive({ CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE: "false" })).toBe(false);
    expect(notificationMigrationMaintenanceActive({ CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE: "true" })).toBe(true);
    const response = notificationMigrationMaintenanceResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("900");
    expect(await response.json()).toMatchObject({ code: "notification_migration_maintenance" });
  });
});
