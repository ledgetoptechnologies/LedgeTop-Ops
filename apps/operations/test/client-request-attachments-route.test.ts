import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  sqlScope: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
  WorkerEntrypoint: class {},
  DurableObject: class {},
}));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  sqlScope: mocks.sqlScope,
}));

import worker from "../src/worker/index";

const principal = {
  id: "staff-reviewer",
  email: "reviewer@example.com",
  displayName: "Staff Reviewer",
  accessSubject: "access-reviewer",
  projectAlphaUserId: "7",
};
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

interface AttachmentRecord {
  id: string;
  submittedRequestId: string;
  name: string;
  contentType: string;
  size: number;
  objectKey: string;
  status: string;
}

function environment(input?: {
  activeRequests?: string[];
  attachments?: AttachmentRecord[];
  objectBytes?: Uint8Array;
}) {
  const activeRequests = new Set(input?.activeRequests ?? ["request-a"]),
    attachments = input?.attachments ?? [],
    queries: Array<{ sql: string; values: unknown[] }> = [],
    get = vi.fn(async (key: string) => {
      const row = attachments.find(attachment => attachment.objectKey === key);
      if (!row || !input?.objectBytes) return null;
      return {
        body: input.objectBytes,
        size: input.objectBytes.byteLength,
        httpEtag: '"accepted-etag"',
      };
    });
  const database = {
    withSession() { return database; },
    prepare(sql: string) {
      const statement = {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          queries.push({ sql, values });
          return this;
        },
        async first() {
          if (sql.includes("SELECT r.id FROM client_service_requests"))
            return activeRequests.has(String(this.values[0])) ? { id: this.values[0] } : null;
          if (sql.includes("SELECT attachment.id,attachment.original_name")) {
            const [attachmentId, requestId] = this.values.map(String);
            const row = attachments.find(attachment =>
              attachment.id === attachmentId &&
              attachment.submittedRequestId === requestId &&
              attachment.status === "accepted" &&
              activeRequests.has(requestId));
            return row ? {
              id: row.id,
              original_name: row.name,
              content_type: row.contentType,
              actual_size: row.size,
              object_key: row.objectKey,
            } : null;
          }
          return null;
        },
        async all() {
          if (!sql.includes("FROM client_service_request_attachments")) return { results: [] };
          const requestId = String(this.values[0]);
          return {
            results: attachments
              .filter(attachment => attachment.submittedRequestId === requestId && attachment.status === "accepted")
              .map(attachment => ({
                id: attachment.id,
                original_name: attachment.name,
                content_type: attachment.contentType,
                actual_size: attachment.size,
              })),
          };
        },
      };
      return statement;
    },
  };
  return {
    env: {
      ENVIRONMENT: "development",
      EXPECTED_HOST: "ops.example",
      INCOMING_EXPECTED_HOST: "incoming.example",
      INCOMING_BASE_URL: "https://incoming.example",
      DELIVERY_DB: database,
      DATA_BUCKET: { get },
    },
    queries,
    get,
  };
}

describe("Operations client-request attachment routes", () => {
  beforeEach(() => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(false);
    mocks.sqlScope.mockReset().mockResolvedValue({
      global: true,
      deniedGlobal: false,
      divisions: [],
      deniedDivisions: [],
    });
  });

  it("lists only accepted attachments for an active request without leaking storage keys", async () => {
    const attachment = {
      id: "attachment-a",
      submittedRequestId: "request-a",
      name: "authorization.pdf",
      contentType: "application/pdf",
      size: 18,
      objectKey: "_ltds/quarantine/request-attachments/opaque-a/object",
      status: "accepted",
    };
    const rejected = { ...attachment, id: "attachment-rejected", status: "rejected" };
    const other = { ...attachment, id: "attachment-other", submittedRequestId: "request-b" };
    const value = environment({ attachments: [attachment, rejected, other] });

    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/attachments"),
      value.env as never,
      executionCtx,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ attachments: [{
      id: "attachment-a",
      name: "authorization.pdf",
      contentType: "application/pdf",
      size: 18,
      downloadPath: "/api/client-service-requests/request-a/attachments/attachment-a/download",
    }] });
    expect(JSON.stringify(payload)).not.toContain("object_key");
    expect(JSON.stringify(payload)).not.toContain("quarantine");
    expect(value.queries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sql: expect.stringContaining("submitted_request_id=? AND status='accepted'"), values: ["request-a"] }),
    ]));
    expect(value.get).not.toHaveBeenCalled();
  });

  it("streams the exact accepted object with private safe download headers", async () => {
    const bytes = new TextEncoder().encode("accepted attachment"),
      value = environment({
        objectBytes: bytes,
        attachments: [{
          id: "attachment-a",
          submittedRequestId: "request-a",
          name: "client \"plan\" é.pdf",
          contentType: "application/pdf",
          size: bytes.byteLength,
          objectKey: "_ltds/quarantine/request-attachments/opaque-a/object",
          status: "accepted",
        }],
      });

    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/attachments/attachment-a/download"),
      value.env as never,
      executionCtx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("accepted attachment");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toContain('attachment; filename="client _plan_ _.pdf"');
    expect(response.headers.get("Content-Disposition")).toContain("filename*=UTF-8''client%20%22plan%22%20%C3%A9.pdf");
    expect(value.get).toHaveBeenCalledWith("_ltds/quarantine/request-attachments/opaque-a/object");
  });

  it("denies staff without global operations.manage before any D1 or R2 access", async () => {
    mocks.sqlScope.mockResolvedValue({ global: false, deniedGlobal: false, divisions: [], deniedDivisions: [] });
    const value = environment();

    const response = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/attachments"),
      value.env as never,
      executionCtx,
    );

    expect(response.status).toBe(403);
    expect(value.queries).toEqual([]);
    expect(value.get).not.toHaveBeenCalled();
  });

  it("returns 404 for inactive requests and cross-request, nonaccepted, or missing downloads", async () => {
    const attachment = {
      id: "attachment-a",
      submittedRequestId: "request-a",
      name: "authorization.pdf",
      contentType: "application/pdf",
      size: 18,
      objectKey: "_ltds/quarantine/request-attachments/opaque-a/object",
      status: "accepted",
    };
    const value = environment({ activeRequests: ["request-a"], attachments: [attachment] });

    const inactive = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-b/attachments"),
      value.env as never,
      executionCtx,
    );
    const crossRequest = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-b/attachments/attachment-a/download"),
      value.env as never,
      executionCtx,
    );
    attachment.status = "rejected";
    const nonaccepted = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/attachments/attachment-a/download"),
      value.env as never,
      executionCtx,
    );
    attachment.status = "accepted";
    const missing = await worker.fetch(
      new Request("https://ops.example/api/client-service-requests/request-a/attachments/attachment-a/download"),
      value.env as never,
      executionCtx,
    );

    expect(inactive.status).toBe(404);
    expect(crossRequest.status).toBe(404);
    expect(nonaccepted.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(value.get).toHaveBeenCalledOnce();
  });
});
