import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  sendProjectAlphaProjectLifecycleCommand,
  validatedProjectLifecycleReceipt,
} from "../src/worker/project-alpha-project-lifecycle-api-v2";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  request = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  project = "2".repeat(32);
const connection = {
  baseUrl: "https://alpha.example.test",
  apiKey: "test-secret",
  expectedSourceInstanceId: source,
  expectedApplicationId: application,
  expectedHistoryEpoch: epoch,
};
function metadata(
  route: Record<string, unknown>,
  capabilities = ["api.capabilities.read", route.requiredCapability as string],
) {
  return {
    apiVersion: "2",
    sourceInstanceId: source,
    applicationId: application,
    historyEpoch: epoch,
    requestId: request,
    grantedCapabilities: capabilities.map((name) => ({ name })),
    implementedEndpoints: [
      {
        method: "GET",
        path: "/api/v2/capabilities",
        requiredCapability: "api.capabilities.read",
      },
      route,
    ],
  };
}
function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
  raw?: string,
) {
  return new Response(raw ?? JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Request-ID": request,
      ...headers,
    },
  });
}
const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

describe("native lifecycle transport evidence", () => {
  const route = {
    method: "POST",
    path: "/api/v2/projects/{publicId}/archive/commands",
    requiredCapability: "projects.lifecycle.archive",
    requiresSourceInstanceId: true,
    requiresApplicationId: true,
    requiresHistoryEpoch: true,
  };
  const receipt = () => ({
    apiVersion: "2",
    sourceInstanceId: source,
    applicationId: application,
    historyEpoch: epoch,
    requestId: request,
    replayed: false,
    accepted: true,
    resource: { type: "project", id: project, revision: "2" },
    result: {
      status: "active",
      completedAt: null as string | null,
      archived: true,
      archivedAt: "2026-10-14T00:00:00Z" as string | null,
      presentation: { portalPublished: false, publicLinkEnabled: false },
    },
  });
  it("preflights the advertised template and dispatches only the concrete pinned route", async () => {
    const send = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === "GET" ? json(metadata(route)) : json(receipt()),
    );
    const result = await sendProjectAlphaProjectLifecycleCommand(
      connection,
      project,
      "archive",
      { commandId: request, expectedRevision: "1" },
      send,
    );
    expect(result.status).toBe("acknowledged");
    expect(String(send.mock.calls[1]![0])).toBe(
      connection.baseUrl + "/api/v2/projects/" + project + "/archive/commands",
    );
    expect(JSON.parse(String(send.mock.calls[1]![1]!.body))).toEqual({
      commandId: request,
      expectedRevision: "1",
    });
    const evidence = validatedProjectLifecycleReceipt(result);
    expect(evidence?.body).toBe(
      JSON.stringify({ commandId: request, expectedRevision: "1" }),
    );
    expect(evidence?.responseSha256).toBe(sha256(JSON.stringify(receipt())));
    if (result.status === "acknowledged")
      (result.response.result as { archived: boolean }).archived = false;
    expect(evidence?.response.result.archived).toBe(true);
    expect(() => {
      (evidence!.response.result as { archived: boolean }).archived = false;
    }).toThrow();
    expect(validatedProjectLifecycleReceipt({ ...result })).toBeNull();
  });
  it.each([
    [
      "accepted false",
      (r: ReturnType<typeof receipt>) => {
        r.accepted = false;
      },
    ],
    [
      "status enum",
      (r: ReturnType<typeof receipt>) => {
        r.result.status = "garbage";
      },
    ],
    [
      "completed timestamp",
      (r: ReturnType<typeof receipt>) => {
        r.result.completedAt = "2026-10-14T00:00:00Z";
      },
    ],
    [
      "completed missingtime",
      (r: ReturnType<typeof receipt>) => {
        r.result.status = "completed";
      },
    ],
    [
      "archive missingtime",
      (r: ReturnType<typeof receipt>) => {
        r.result.archivedAt = null;
      },
    ],
    [
      "project publication",
      (r: ReturnType<typeof receipt>) => {
        r.result.presentation.portalPublished = true;
      },
    ],
    [
      "public link publication",
      (r: ReturnType<typeof receipt>) => {
        r.result.presentation.publicLinkEnabled = true;
      },
    ],
    [
      "cross source",
      (r: ReturnType<typeof receipt>) => {
        r.sourceInstanceId = application;
      },
    ],
  ])(
    "does not mint receipt for malformed successfulHTTP: %s",
    async (_label, mutate) => {
      const r = receipt();
      mutate(r);
      const send = vi.fn<typeof fetch>(async (_url, init) =>
        init?.method === "GET" ? json(metadata(route)) : json(r),
      );
      const result = await sendProjectAlphaProjectLifecycleCommand(
        connection,
        project,
        "archive",
        { commandId: request, expectedRevision: "1" },
        send,
      );
      expect(result).toMatchObject({
        status: "uncertain",
        reason: "invalid_contract",
      });
      expect(validatedProjectLifecycleReceipt(result)).toBeNull();
    },
  );
});
