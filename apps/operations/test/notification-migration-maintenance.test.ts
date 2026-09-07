import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationMigrationMaintenanceActive, notificationMigrationMaintenanceResponse } from "@ltds/shared";
import type { Env } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(), isAdministrator: vi.fn(), sqlScope: vi.fn(), requireMutationSecurity: vi.fn(),
  requestOutbox: vi.fn(), folderGrantOutbox: vi.fn(), folderChangeOutbox: vi.fn(), incomingUpload: vi.fn(),
  clientFeedback: vi.fn(), viewerProcessing: vi.fn(), accessExpiry: vi.fn(), authenticatedDelivery: vi.fn(),
  revokeViewerSessions: vi.fn(), thumbnailBackfill: vi.fn(), legacyThumbnailRecovery: vi.fn(), republishThumbnails: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/acl")>(), isAdministrator: mocks.isAdministrator, sqlScope: mocks.sqlScope }));
vi.mock("../src/worker/request-security", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/request-security")>(), requireMutationSecurity: mocks.requireMutationSecurity }));
vi.mock("../src/worker/notifications", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/notifications")>(), processClientPortalRequestNotifications: mocks.requestOutbox }));
vi.mock("../src/worker/client-folder-grants", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/client-folder-grants")>(), processClientFolderGrantNotifications: mocks.folderGrantOutbox, processClientFolderChangeNotifications: mocks.folderChangeOutbox }));
vi.mock("../src/worker/incoming-upload-notifications", () => ({ processIncomingUploadNotifications: mocks.incomingUpload }));
vi.mock("../src/worker/client-feedback-notifications", () => ({ processClientFeedbackNotifications: mocks.clientFeedback }));
vi.mock("../src/worker/viewer-processing", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/viewer-processing")>(), processViewerProcessingNotifications: mocks.viewerProcessing }));
vi.mock("../src/worker/project-access-expiry-notifications", () => ({ processProjectAccessExpiryNotifications: mocks.accessExpiry }));
vi.mock("../src/worker/authenticated-delivery-change-notifications", () => ({ processAuthenticatedDeliveryChangeNotifications: mocks.authenticatedDelivery }));
vi.mock("../src/worker/viewer-integration", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/viewer-integration")>(), drainViewerSessionRevocations: mocks.revokeViewerSessions }));
vi.mock("../src/worker/thumbnail-backfill", () => ({ processThumbnailBackfills: mocks.thumbnailBackfill }));
vi.mock("../src/worker/video-thumbnail-recovery", () => ({ processLegacyVideoThumbnailRecovery: mocks.legacyThumbnailRecovery }));
vi.mock("../src/worker/image-thumbnails", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/image-thumbnails")>(), republishPendingThumbnailFallbacks: mocks.republishThumbnails }));

import worker from "../src/worker/index";

const principal = { id: "staff-admin", email: "admin@example.com", displayName: "Admin", accessSubject: "access-admin", projectAlphaUserId: "3" };
const scheduledEvent = { cron: "*/5 * * * *", scheduledTime: 1787703420000, noRetry() {} } as ScheduledController;

function database(writes: string[]) {
  const statement = { bind() { return statement; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { writes.push("run"); return { meta: { changes: 1 } }; } };
  return { prepare() { return statement; }, async batch() { writes.push("batch"); return []; }, withSession() { return this; } };
}
function environment(writes: string[], maintenance?: string): Env {
  return { ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example", OPS_DB: database(writes), DELIVERY_DB: database(writes), ...(maintenance === undefined ? {} : { CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE: maintenance }) } as unknown as Env;
}

beforeEach(() => {
  mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
  mocks.isAdministrator.mockReset().mockResolvedValue(true);
  mocks.sqlScope.mockReset().mockResolvedValue({ global: true, deniedGlobal: false, divisions: [], deniedDivisions: [] });
  mocks.requireMutationSecurity.mockReset().mockResolvedValue(undefined);
  for (const mock of [mocks.requestOutbox, mocks.folderGrantOutbox, mocks.folderChangeOutbox, mocks.incomingUpload, mocks.clientFeedback, mocks.viewerProcessing, mocks.accessExpiry, mocks.authenticatedDelivery, mocks.revokeViewerSessions, mocks.thumbnailBackfill, mocks.legacyThumbnailRecovery, mocks.republishThumbnails]) mock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

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

  it("skips notification-migration outboxes on the scheduled tick while unrelated work remains active", async () => {
    const detached: Promise<unknown>[] = [];
    const context = { waitUntil(work: Promise<unknown>) { detached.push(work); }, passThroughOnException() {} } as unknown as ExecutionContext;
    await worker.scheduled(scheduledEvent, environment([], "true"), context);
    await Promise.all(detached);
    expect(mocks.requestOutbox).not.toHaveBeenCalled();
    expect(mocks.folderGrantOutbox).not.toHaveBeenCalled();
    expect(mocks.folderChangeOutbox).not.toHaveBeenCalled();
    expect(mocks.incomingUpload).toHaveBeenCalledOnce();
    expect(mocks.clientFeedback).toHaveBeenCalledOnce();
    expect(mocks.viewerProcessing).toHaveBeenCalledOnce();
    expect(mocks.accessExpiry).toHaveBeenCalledOnce();
    expect(mocks.authenticatedDelivery).toHaveBeenCalledOnce();
    expect(mocks.revokeViewerSessions).toHaveBeenCalledOnce();
    expect(mocks.thumbnailBackfill).toHaveBeenCalledOnce();
  });

  it("returns Retry-After maintenance before an authenticated request write, while false proceeds to the real route", async () => {
    const writes: string[] = [];
    const request = () => new Request("https://ops.example/api/client-service-requests/request-a/pa-draft", { method: "POST", headers: { Origin: "https://ops.example", "Content-Type": "application/json" }, body: "{}" });
    const blocked = await worker.fetch(request(), environment(writes, "true"), {} as ExecutionContext);
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("Retry-After")).toBe("900");
    expect(await blocked.json()).toMatchObject({ code: "notification_migration_maintenance" });
    expect(mocks.authenticateStaff).toHaveBeenCalledOnce();
    expect(mocks.requireMutationSecurity).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
    const unblocked = await worker.fetch(request(), environment(writes, "false"), {} as ExecutionContext);
    expect(unblocked.status).toBe(404);
    expect(writes).toEqual([]);
  });

  it("does not let maintenance bypass administrator authorization", async () => {
    mocks.isAdministrator.mockResolvedValue(false);
    const response = await worker.fetch(new Request("https://ops.example/api/client-service-requests/request-a/pa-draft", { method: "POST", headers: { Origin: "https://ops.example", "Content-Type": "application/json" }, body: "{}" }), environment([], "true"), {} as ExecutionContext);
    expect(response.status).toBe(403);
  });
});
