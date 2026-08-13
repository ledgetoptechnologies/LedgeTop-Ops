import { describe, expect, it, vi } from "vitest";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import {
  canonicalRequestAttachmentEtag,
  presignRequestAttachmentPart,
  requestAttachmentPartLength,
  requestAttachmentsAvailable,
  validateRequestAttachment,
  REQUEST_ATTACHMENT_MAX_FILE_BYTES,
  REQUEST_ATTACHMENT_PART_BYTES,
} from "../src/worker/client-portal/request-attachments";
import type { ClientPortalRepository, ClientPortalSession, ResolveClientPrincipal } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const configuredEnv = {
  CLIENT_REQUEST_ATTACHMENTS_ENABLED: "true",
  CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET: "s".repeat(32),
  R2_S3_ENDPOINT: "https://846c924bf17bf4f3dd15c97a4c5d1d51.r2.cloudflarestorage.com",
  R2_BUCKET_NAME: "client-data",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret".repeat(8),
} as Env;

describe("client request attachment policy", () => {
  it("accepts only the exact image/PDF allowlist and bounds", () => {
    expect(validateRequestAttachment("site.JPG", "image/jpeg", 1)).toEqual({ name: "site.JPG", contentType: "image/jpeg" });
    expect(validateRequestAttachment("authorization.pdf", "application/pdf; charset=binary", REQUEST_ATTACHMENT_MAX_FILE_BYTES).contentType).toBe("application/pdf");
    for (const [name, type] of [["payload.zip", "application/zip"], ["map.svg", "image/svg+xml"], ["page.html", "text/html"], ["script.pdf.exe", "application/pdf"], ["photo.png", "image/jpeg"]]) {
      expect(() => validateRequestAttachment(name!, type!, 10)).toThrow();
    }
    expect(() => validateRequestAttachment("large.pdf", "application/pdf", REQUEST_ATTACHMENT_MAX_FILE_BYTES + 1)).toThrow();
  });

  it("uses bounded multipart parts and canonical ETags", () => {
    expect(requestAttachmentPartLength(REQUEST_ATTACHMENT_PART_BYTES + 7, 1)).toBe(REQUEST_ATTACHMENT_PART_BYTES);
    expect(requestAttachmentPartLength(REQUEST_ATTACHMENT_PART_BYTES + 7, 2)).toBe(7);
    expect(() => requestAttachmentPartLength(7, 2)).toThrow();
    expect(canonicalRequestAttachmentEtag(`"${"A".repeat(32)}"`)).toBe("a".repeat(32));
    expect(canonicalRequestAttachmentEtag("not-an-etag")).toBeNull();
  });

  it("fails closed without the feature flag, scanner secret, or signer configuration", () => {
    expect(requestAttachmentsAvailable({ ...configuredEnv, CLIENT_REQUEST_ATTACHMENTS_ENABLED: "false" })).toBe(false);
    expect(requestAttachmentsAvailable({ ...configuredEnv, CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET: "" })).toBe(false);
    expect(requestAttachmentsAvailable({ ...configuredEnv, R2_S3_ENDPOINT: "https://example.com" })).toBe(false);
    expect(requestAttachmentsAvailable(configuredEnv)).toBe(true);
  });

  it("signs one short-lived object/upload/part with exact content headers", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const ticket = await presignRequestAttachmentPart({ env: configuredEnv, key: "_ltds/quarantine/request-attachments/a/object", uploadId: "upload-a", partNumber: 2, contentLength: 7, contentType: "application/pdf", now });
    const url = new URL(ticket.url);
    expect(url.pathname).toBe("/client-data/_ltds/quarantine/request-attachments/a/object");
    expect(url.searchParams.get("uploadId")).toBe("upload-a");
    expect(url.searchParams.get("partNumber")).toBe("2");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(ticket.expiresAt).toBe("2026-08-13T12:05:00.000Z");
    const other = await presignRequestAttachmentPart({ env: configuredEnv, key: "_ltds/quarantine/request-attachments/b/object", uploadId: "upload-b", partNumber: 2, contentLength: 7, contentType: "application/pdf", now });
    expect(other.url).not.toBe(ticket.url);
  });
});

const portalSession: ClientPortalSession = { accountId: "account-a", identityId: "identity-a", displayName: "Acme", role: "manager", canViewBilling: false };
const principal: ResolveClientPrincipal = vi.fn(async () => ({ issuer: "https://identity.example", subject: "user", email: "client@example.com" }));
function disabledRepository(): ClientPortalRepository {
  return {
    resolveSession: vi.fn(async () => portalSession), listProjects: vi.fn(async () => []), getProject: vi.fn(async () => null),
    listProjectFiles: vi.fn(async () => null), listPastDeliveries: vi.fn(async () => ({ files: [], prefix: "", cursor: null })),
    listProjectFileLocations: vi.fn(async () => null), listPastDeliveryLocations: vi.fn(async () => ({ points: [], imageCount: 0, truncated: false })),
    getAuthorizedFile: vi.fn(async () => null), listDeliveries: vi.fn(async () => []), getDeliveryHandoff: vi.fn(async () => null),
    listNotifications: vi.fn(async () => ({ notifications: [], unreadCount: 0, cursor: null })), updateNotification: vi.fn(async () => false),
    listServiceRequests: vi.fn(async () => []), getServiceRequest: vi.fn(async () => null), createServiceRequest: vi.fn(async () => null),
    updateServiceRequest: vi.fn(async () => null), createChangeRequest: vi.fn(async () => null), listMembers: vi.fn(async () => []),
    listInvitations: vi.fn(async () => []), createInvitation: vi.fn(async () => null), revokeMember: vi.fn(async () => false), revokeInvitation: vi.fn(async () => false),
  };
}

describe("client request v2 feature boundary", () => {
  it("returns 404 for every catalog, draft, attachment, and submitted-attachment surface while disabled", async () => {
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: disabledRepository() });
    const env = { CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_REQUEST_V2_ENABLED: "false", CLIENT_PORTAL_ORIGIN: "https://client.example", ENVIRONMENT: "development" } as Env;
    const cases: Array<[string, string]> = [
      ["GET", "/service-catalog"], ["POST", "/service-request-drafts"], ["GET", "/service-request-drafts/draft-a"],
      ["POST", "/service-request-drafts/draft-a/attachments"], ["POST", "/service-request-drafts/draft-a/attachments/file-a/part-ticket"],
      ["PUT", "/service-request-drafts/draft-a/attachments/file-a/parts/1"], ["POST", "/service-request-drafts/draft-a/attachments/file-a/complete"],
      ["DELETE", "/service-request-drafts/draft-a/attachments/file-a"], ["GET", "/service-requests/request-a/attachments"],
      ["GET", "/service-requests/request-a/attachments/file-a/download"],
    ];
    for (const [method, path] of cases) {
      const response = await app.request(`https://client.example${path}`, { method, headers: { Origin: "https://client.example", "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" }, env);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});
