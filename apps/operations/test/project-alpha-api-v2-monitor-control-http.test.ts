import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleProjectAlphaApiV2MonitorControlHttp,
  projectAlphaApiV2MonitorControlHttpRequest,
  type ProjectAlphaApiV2MonitorControlHttpDependencies } from "../src/worker/project-alpha-api-v2-monitor-control-http";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
import { NativeMonitorControlDenied, NativeMonitorControlOutcomeUnknown } from "../src/worker/project-alpha-api-v2-monitor-native-control";
import { ProjectAlphaApiV2MonitorLifecycleConflict } from "../src/worker/project-alpha-api-v2-monitor-lifecycle";
import { ProjectAlphaApiV2MonitorControlReadError, ProjectAlphaApiV2MonitorControlReadUnavailableError } from "../src/worker/project-alpha-api-v2-monitor-control-read";

const calls = vi.hoisted(() => ({ auth: vi.fn(), apply: vi.fn(), read: vi.fn(), quota: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({
  authenticateNativeStaffWithAdmissionVersion: calls.auth,
}));
vi.mock("../src/worker/project-alpha-api-v2-monitor-native-control", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker/project-alpha-api-v2-monitor-native-control")>(),
  applyNativeProjectAlphaApiV2MonitorLifecycle: calls.apply,
}));
vi.mock("../src/worker/project-alpha-api-v2-monitor-control-read", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker/project-alpha-api-v2-monitor-control-read")>(),
  readProjectAlphaApiV2MonitorControl: calls.read,
}));

const origin = "https://ops.example.test";
const validConnections = JSON.stringify({ version: 1, connections: [{
  sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  baseUrl: "https://primary.example.test",
  expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", apiKey: "key-value",
}] });
const identity = Object.freeze({ kind: "native" as const, staffId: "staff-admin",
  verifiedAccessSubject: "provider|opaque/subject", email: "admin@example.test",
  displayName: "Admin", profileVersion: 1 });
const auth = (): AuthenticatedNativeStaffWithAdmissionVersion => Object.freeze({ identity,
  admissionVersion: 7, verifiedUntil: new Date(Date.now() + 300_000).toISOString() });
const database = {} as D1Database;

function deps(overrides: Partial<ProjectAlphaApiV2MonitorControlHttpDependencies> = {}) {
  return {
    configuration: overrides.configuration ?? { enabled: true,
      issuer: "https://synthetic-team.cloudflareaccess.com", staffAudience: "regular-staff-audience",
      onboardingAudience: "dedicated-onboarding-audience", origin, csrfSecret: "x".repeat(48) },
    database: overrides.database ?? database,
    projectAlphaConnectionsJson: overrides.projectAlphaConnectionsJson ?? validConnections,
    consumeRateLimit: overrides.consumeRateLimit ?? calls.quota,
  } satisfies ProjectAlphaApiV2MonitorControlHttpDependencies;
}

function request(method: "GET" | "POST", path: string, body?: unknown,
  headers: Record<string, string> = {}): Request {
  return new Request(`${origin}${path}`, { method, headers: {
    ...(method === "GET" ? { "X-Native-Integration-Request": "1" }
      : { Origin: origin, "Content-Type": "application/json" }), ...headers },
  body: method === "POST" ? JSON.stringify(body) : undefined });
}

async function csrf(): Promise<string> {
  const reply = await handleProjectAlphaApiV2MonitorControlHttp(
    request("GET", "/api/native-integrations/monitor/session"), deps());
  expect(reply.status).toBe(200);
  return (await reply.json() as { csrfToken: string }).csrfToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.quota.mockResolvedValue(true);
  calls.auth.mockResolvedValue(auth());
  calls.apply.mockResolvedValue({ revision: 3, enabled: true, identities: [] });
  calls.read.mockResolvedValue({ revision: 3, enabled: true, attributed: true });
});

describe("native API-v2 monitor control HTTP boundary", () => {
  it("reserves only exact session/apply routes and uses native integration session headers", async () => {
    expect(projectAlphaApiV2MonitorControlHttpRequest("GET", "/api/native-integrations/monitor/session")).toBe("session");
    expect(projectAlphaApiV2MonitorControlHttpRequest("POST", "/api/native-integrations/monitor")).toBe("apply");
    expect(projectAlphaApiV2MonitorControlHttpRequest("GET", "/api/native-integrations/monitor")).toBeNull();
    expect(projectAlphaApiV2MonitorControlHttpRequest("POST", "/api/native-integrations/monitor/")).toBeNull();
    const missingHeader = await handleProjectAlphaApiV2MonitorControlHttp(
      request("GET", "/api/native-integrations/monitor/session", undefined, { "X-Native-Integration-Request": "0" }), deps());
    expect(missingHeader.status).toBe(403);
    expect(calls.auth).not.toHaveBeenCalled();
  });

  it("issues a purpose-separated CSRF session and returns no configuration data", async () => {
    const authenticated = auth();
    calls.auth.mockResolvedValueOnce(authenticated);
    const reply = await handleProjectAlphaApiV2MonitorControlHttp(
      request("GET", "/api/native-integrations/monitor/session"), deps());
    expect(reply.status).toBe(200);
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    const body = await reply.json() as Record<string, unknown>;
    expect(body.csrfToken).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(body.verifiedUntil).toBe(authenticated.verifiedUntil);
    expect(JSON.stringify(body)).not.toContain("key-value");
    expect(JSON.stringify(body)).not.toContain("primary.example.test");
  });

  it("requires same-origin, CSRF, native auth, and an exact bounded body", async () => {
    const missingCsrf = await handleProjectAlphaApiV2MonitorControlHttp(
      request("POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: false }), deps());
    expect(missingCsrf.status).toBe(403);
    const token = await csrf();
    const foreign = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: false },
      { Origin: "https://evil.example.test", "X-CSRF-Token": token }), deps());
    expect(foreign.status).toBe(403);
    for (const body of [
      { expectedRevision: 0 },
      { expectedRevision: 0, enabled: false, identities: [] },
      { expectedRevision: -1, enabled: false },
      { expectedRevision: 0.5, enabled: false },
      { expectedRevision: 0, enabled: "false" },
    ]) {
      const reply = await handleProjectAlphaApiV2MonitorControlHttp(request(
        "POST", "/api/native-integrations/monitor", body, { "X-CSRF-Token": token }), deps());
      expect(reply.status).toBe(400);
    }
    const oversized = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: false,
        padding: "x".repeat(5_000) }, { "X-CSRF-Token": token }), deps());
    expect(oversized.status).toBe(413);
    expect(calls.apply).not.toHaveBeenCalled();
  });

  it("derives enabled identity pins only from the captured server configuration", async () => {
    const dependencies = deps() as ProjectAlphaApiV2MonitorControlHttpDependencies & { projectAlphaConnectionsJson?: string };
    const before = dependencies.projectAlphaConnectionsJson;
    const token = await csrf();
    calls.auth.mockImplementationOnce(async () => {
      dependencies.projectAlphaConnectionsJson = "not-json-after-auth";
      return auth();
    });
    const reply = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: true },
      { "X-CSRF-Token": token }), dependencies);
    expect(reply.status).toBe(200);
    expect(calls.apply).toHaveBeenCalledWith(database, expect.objectContaining({
      expectedRevision: 0, enabled: true,
      identities: [{ sourceId: "project-alpha:primary", applicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        baseUrl: "https://primary.example.test", expectedSourceInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }],
    }));
    expect(before).toBe(validConnections);
    expect(JSON.stringify(await reply.clone().json())).not.toContain("key-value");
  });

  it("allows disabling despite malformed deployment configuration and never accepts browser identities", async () => {
    const token = await csrf();
    const brokenConfig = deps({ projectAlphaConnectionsJson: "malformed" });
    const disabled = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 7, enabled: false },
      { "X-CSRF-Token": token }), brokenConfig);
    expect(disabled.status).toBe(200);
    expect(calls.apply).toHaveBeenCalledWith(database, expect.objectContaining({
      expectedRevision: 7, enabled: false, identities: [],
    }));
    calls.apply.mockClear();
    const injected = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 7, enabled: true,
        sourceIdentities: [{ sourceId: "project-alpha:attacker" }], apiKey: "browser-secret" },
      { "X-CSRF-Token": token }), deps());
    expect(injected.status).toBe(400);
    expect(calls.apply).not.toHaveBeenCalled();
  });

  it("fails closed for malformed enabled config, stale revisions, and uncertain writes", async () => {
    const token = await csrf();
    const malformed = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: true },
      { "X-CSRF-Token": token }), deps({ projectAlphaConnectionsJson: "malformed" }));
    expect(malformed.status).toBe(503);
    calls.apply.mockRejectedValueOnce(new ProjectAlphaApiV2MonitorLifecycleConflict());
    const conflict = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: true },
      { "X-CSRF-Token": token }), deps());
    expect(conflict.status).toBe(409);
    calls.apply.mockRejectedValueOnce(new NativeMonitorControlOutcomeUnknown());
    const uncertain = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: true },
      { "X-CSRF-Token": token }), deps());
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toEqual({ error: "native_monitor_outcome_unknown" });
  });

  it("preserves the native writer's explicit authorization denial as a 403", async () => {
    const token = await csrf();
    calls.apply.mockRejectedValueOnce(new NativeMonitorControlDenied());
    const denied = await handleProjectAlphaApiV2MonitorControlHttp(request(
      "POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: true },
      { "X-CSRF-Token": token }), deps());
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "native_monitor_denied" });
  });

  it("does not classify untyped database messages as confirmed denial or conflict", async () => {
    const token = await csrf();
    for (const message of ["native_monitor_control_denied", "project_alpha_api_v2_monitor_lifecycle_conflict",
      "database transport failed with private connection details"]) {
      calls.apply.mockRejectedValueOnce(new Error(message));
      const reply = await handleProjectAlphaApiV2MonitorControlHttp(request(
        "POST", "/api/native-integrations/monitor", { expectedRevision: 0, enabled: true },
        { "X-CSRF-Token": token }), deps());
      expect(reply.status).toBe(503);
      expect(await reply.json()).toEqual({ error: "native_monitor_outcome_unknown" });
    }
  });

  it("reads authorized state without a mutation or parsing broken PA configuration", async () => {
    const reply = await handleProjectAlphaApiV2MonitorControlHttp(
      request("GET", "/api/native-integrations/monitor/state"), deps({ projectAlphaConnectionsJson: "broken" }));
    expect(reply.status).toBe(200);
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect(await reply.json()).toEqual({ revision: 3, enabled: true, attributed: true });
    expect(calls.read).toHaveBeenCalledWith(database, expect.objectContaining({ identity, admissionVersion: 7 }));
    expect(calls.apply).not.toHaveBeenCalled();
  });

  it("requires the same-origin custom-header boundary for state reads", async () => {
    const headerCases: Array<Record<string, string>> = [{ "X-Native-Integration-Request": "0" },
      { Origin: "https://foreign.example.test" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of headerCases) {
      const reply = await handleProjectAlphaApiV2MonitorControlHttp(
        request("GET", "/api/native-integrations/monitor/state", undefined, headers), deps());
      expect(reply.status).toBe(403);
    }
    expect(calls.read).not.toHaveBeenCalled();
    expect(calls.apply).not.toHaveBeenCalled();
  });

  it("does not turn unavailable or denied reads into a disabled state", async () => {
    calls.read.mockRejectedValueOnce(new ProjectAlphaApiV2MonitorControlReadUnavailableError());
    const unavailable = await handleProjectAlphaApiV2MonitorControlHttp(
      request("GET", "/api/native-integrations/monitor/state"), deps());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "native_monitor_unavailable" });
    calls.read.mockRejectedValueOnce(new ProjectAlphaApiV2MonitorControlReadError());
    const denied = await handleProjectAlphaApiV2MonitorControlHttp(
      request("GET", "/api/native-integrations/monitor/state"), deps());
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "native_monitor_denied" });
    expect(calls.apply).not.toHaveBeenCalled();
  });

  it("rejects authentication, rate-limit, and expiry failures without store calls", async () => {
    calls.auth.mockRejectedValueOnce(new Error("denied"));
    const denied = await handleProjectAlphaApiV2MonitorControlHttp(
      request("GET", "/api/native-integrations/monitor/session"), deps());
    expect(denied.status).toBe(403);
    calls.auth.mockResolvedValueOnce(Object.freeze({ ...auth(),
      verifiedUntil: "2000-01-01T00:00:00.000Z" }));
    const expired = await handleProjectAlphaApiV2MonitorControlHttp(
      request("GET", "/api/native-integrations/monitor/session"), deps());
    expect(expired.status).toBe(403);
    calls.quota.mockResolvedValueOnce(false);
    const rateLimited = await handleProjectAlphaApiV2MonitorControlHttp(
      request("GET", "/api/native-integrations/monitor/session"), deps());
    expect(rateLimited.status).toBe(429);
    expect(calls.apply).not.toHaveBeenCalled();
  });
});
