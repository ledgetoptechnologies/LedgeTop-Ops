import sql from "../migrations/0096_client_portal_foundation.sql?raw";
import { sha256 } from "../src/worker/security";
import { describe, expect, it } from "vitest";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import { clientPortalNotificationsAvailable } from "../src/worker/client-portal/schema-readiness";
import type { ClientPortalSession } from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

interface Call {
  sql: string;
  binds: unknown[];
}

function recordingEnv(options: {
  first?: (call: Call) => unknown;
  all?: (call: Call) => unknown[];
  changes?: (call: Call) => number;
} = {}): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const database = {
    prepare(sql: string) {
      const call: Call = { sql, binds: [] };
      calls.push(call);
      const statement = {
        bind(...values: unknown[]) {
          call.binds = values;
          return statement;
        },
        async first<T>() {
          return (options.first?.(call) ?? null) as T | null;
        },
        async all<T>() {
          return { results: (options.all?.(call) ?? []) as T[] };
        },
        async run() {
          return { meta: { changes: options.changes?.(call) ?? 0 } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
      return Promise.all(statements.map(statement => statement.run()));
    },
    withSession(consistency: string) {
      expect(consistency).toBe("first-primary");
      return database;
    },
  };
  return { env: { DELIVERY_DB: database } as unknown as Env, calls };
}

const session: ClientPortalSession = { accountId: "account-a", identityId: "identity-a", displayName: "Acme", role: "manager", canViewBilling: false };

describe("client portal additive schema readiness", () => {
  it.each([[0, false], [1, true]] as const)(
    "reports notification table count %s as available=%s",
    async (count, expected) => {
      const value = recordingEnv({ first: () => ({ count }) });
      await expect(clientPortalNotificationsAvailable(value.env)).resolves.toBe(expected);
      expect(value.calls).toHaveLength(1);
      expect(value.calls[0]?.sql).toContain("sqlite_master");
      expect(value.calls[0]?.binds).toEqual(["client_portal_notifications"]);
    },
  );
});

describe("client portal identity resolution", () => {
  it("resolves only the exact verified issuer and subject into an active account", async () => {
    const value = recordingEnv({
      first: () => ({ account_id: "account-a", identity_id: "identity-a", display_name: "Acme", role: "manager", can_view_billing: 0 }),
    });
    await expect(d1ClientPortalRepository.resolveSession(value.env, {
      issuer: "https://identity.example",
      subject: "subject-1", email: "client@example.com",
    })).resolves.toEqual(session);
    expect(value.calls[0]?.binds).toEqual(["https://identity.example", "subject-1"]);
    expect(value.calls[0]?.sql).toContain("i.issuer=? AND i.subject=?");
    expect(value.calls[0]?.sql).toContain("i.revoked_at IS NULL");
    expect(value.calls[0]?.sql).toContain("a.status='active'");
    expect(value.calls[0]?.sql).not.toContain("email");
  });

  it("rejects malformed verified claims before touching D1", async () => {
    const value = recordingEnv();
    await expect(d1ClientPortalRepository.resolveSession(value.env, {
      issuer: "https://identity.example",
      subject: " subject-1", email: "client@example.com",
    })).resolves.toBeNull();
    expect(value.calls).toHaveLength(0);
  });
});

describe("client portal grant enforcement", () => {
  it("resolves a project file only while every current session, project, member, and folder grant holds in the same query", async () => {
    const value = recordingEnv();
    const fileId = Buffer.from("clients/acme/north/report.pdf").toString("base64url");
    await expect(d1ClientPortalRepository.getAuthorizedFile(value.env, session, fileId, "project-a")).resolves.toBeNull();
    expect(value.calls).toHaveLength(1);
    const call = value.calls[0]!;
    expect(call.binds).toEqual(["clients/acme/north/report.pdf", "account-a", "identity-a", "project", "project-a"]);
    for (const condition of [
      "a.status='active'",
      "i.revoked_at IS NULL",
      "m.revoked_at IS NULL",
      "g.account_id=a.id",
      "g.revoked_at IS NULL",
      "p.active=1",
      "association.account_id=a.id",
      "association.project_id=?",
      "association.revoked_at IS NULL",
      "member_grant.revoked_at IS NULL",
      "tombstone.restored_at IS NULL",
      "tombstone.physical_key=f.r2_key",
      "tombstone.tombstone_kind='prefix'",
    ]) expect(call.sql).toContain(condition);
  });

  it("lists geotags only through current project, member, folder, asset-version, and tombstone controls", async () => {
    const value = recordingEnv({
      first: (call) => call.sql.includes("SELECT p.id,p.external_ref") ? {
        id: "project-a", external_ref: "A", client_name: "Acme", project_name: "Plant",
        can_request_service: 1, status: "active", summary: null, site_address: null,
        service_address: null, project_contact_name: null, project_contact_email: null,
        project_contact_phone: null, next_milestone: null, source_updated_at: null,
      } : null,
      all: (call) => call.sql.includes("image_asset_locations")
        ? [{ latitude: 44.5, longitude: -88.1 }]
        : [],
    });
    await expect(d1ClientPortalRepository.listProjectFileLocations(value.env, session, "project-a"))
      .resolves.toEqual({ points: [{ latitude: 44.5, longitude: -88.1, imageCount: 1 }], imageCount: 1, truncated: false });
    const call = value.calls.find(candidate => candidate.sql.includes("image_asset_locations"))!;
    expect(call.binds).toEqual(["account-a", "identity-a", "project-a", 501]);
    for (const condition of [
      "a.status='active'", "i.revoked_at IS NULL", "m.revoked_at IS NULL",
      "g.revoked_at IS NULL", "p.active=1", "association.revoked_at IS NULL",
      "location.source_etag=trim(file.etag,'\"')", "location.status='ready'",
      "tombstone.restored_at IS NULL", "member_grant.revoked_at IS NULL",
    ]) expect(call.sql).toContain(condition);
  });

  it("lists a delivery only through active account, identity, project, delivery, share, and version joins", async () => {
    const value = recordingEnv({
      all: () => [{
        share_id: "share-a",
        project_id: "project-a",
        public_id: "public-a",
        share_version: 4,
        label: "Finals",
        expires_at: null,
        requires_password: 1,
      }],
    });
    await expect(d1ClientPortalRepository.listDeliveries(value.env, session, "project-a")).resolves.toEqual([{
      shareId: "share-a",
      publicId: "public-a",
      shareVersion: 4,
      label: "Finals",
      expiresAt: null,
      requiresPassword: true,
      handoffPath: "/api/client/projects/project-a/deliveries/share-a/handoff",
    }]);
    const call = value.calls[0]!;
    expect(call.binds).toEqual(["account-a", "identity-a", "project-a"]);
    for (const condition of [
      "a.status='active'",
      "i.revoked_at IS NULL",
      "g.account_id=a.id",
      "g.revoked_at IS NULL",
      "p.active=1",
      "s.project_id=d.project_id",
      "s.share_version=d.share_version",
      "d.account_id=a.id",
      "d.revoked_at IS NULL",
      "s.revoked_at IS NULL",
      "s.public_id IS NOT NULL",
    ]) expect(call.sql).toContain(condition);
    expect(call.sql).not.toContain("recipient_email");
    expect(call.sql).not.toContain("client_name=");
    expect(call.sql).not.toContain("r2_prefix");
  });

  it("scopes service request reads to the resolved account, identity, active project grant, and project", async () => {
    const value = recordingEnv();
    await expect(d1ClientPortalRepository.getServiceRequest(value.env, session, "request-b")).resolves.toBeNull();
    const call = value.calls[0]!;
    expect(call.binds).toEqual(["account-a", "identity-a", "request-b"]);
    expect(call.sql).toContain("r.id=? AND r.account_id=a.id");
    expect(call.sql).toContain("request_grant.account_id=a.id");
    expect(call.sql).toContain("request_grant.revoked_at IS NULL");
    expect(call.sql).toContain("request_project.active=1");
  });
});

describe("client service request writes", () => {
  const input = {
    projectId: "project-a",
    idempotencyKey: "request-test-0001",
    requestType: "service" as const,
    title: "Model refresh",
    details: "Refresh the current site model.",
    location: null,
    preferredStartAt: null,
  };

  it("performs no insert unless one SQL statement revalidates every server-side grant", async () => {
    const value = recordingEnv({ changes: () => 0 });
    await expect(d1ClientPortalRepository.createServiceRequest(value.env, session, input)).resolves.toBeNull();
    expect(value.calls).toHaveLength(6);
    const call = value.calls.find(entry => entry.sql.includes("INSERT INTO client_service_requests"))!;
    expect(call.sql).toContain("INSERT INTO client_service_requests");
    expect(call.sql).toContain("SELECT ?,a.id,g.project_id,?,i.id");
    expect(call.sql).toContain("g.can_request_service=1");
    expect(call.sql).toContain("a.status='active'");
    expect(call.sql).toContain("p.active=1");
    expect(call.binds).toContain("request-test-0001");
    expect(call.binds.slice(-5)).toEqual(["identity-a", "project-a", "account-a", null, null]);
  });

  it("returns the created request through the same account-scoped read path", async () => {
    const value = recordingEnv({
      changes: call => call.sql.includes("INSERT INTO") ? 1 : 0,
      first: call => call.sql.includes("SELECT p.project_name")
        ? { project_name: "North Distribution Center" }
        : call.sql.includes("r.id=?") ? {
        id: "request-a",
        project_id: "project-a",
        request_type: "service",
        title: "Model refresh",
        details: "Refresh the current site model.",
        location_text: null,
        preferred_start_at: null,
        status: "submitted",
        created_at: "2026-07-31 12:00:00",
        updated_at: "2026-07-31 12:00:00",
      } : null,
    });
    const created = await d1ClientPortalRepository.createServiceRequest(value.env, session, input);
    expect(created).toMatchObject({ kind: "created", request: { id: "request-a", projectId: "project-a", status: "submitted" } });
    expect(value.calls).toHaveLength(7);
    expect(value.calls.at(-1)?.binds.slice(0, 2)).toEqual(["account-a", "identity-a"]);
    const outbox = value.calls.find(call => call.sql.includes("client_portal_notification_outbox"));
    expect(outbox).toBeDefined();
    const notification = JSON.parse(String(outbox?.binds.at(-1)));
    expect(notification).toEqual({
      presentationVersion: 1,
      title: "Model refresh",
      projectContext: { kind: "existing_project", label: "North Distribution Center" },
      scopeLabel: "General service",
      locationLabel: "Location not specified",
      lifecycle: "submitted",
      action: "review_in_operations",
    });
    expect(JSON.stringify(notification)).not.toMatch(/flight|amount|currency|quote|contact|billing/i);
  });
});

describe("client portal migration safety", () => {


  it("is additive, grants no seeded access, and leaves public shares/file quarantine intact", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS client_accounts");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS client_project_grants");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS client_delivery_grants");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS client_service_requests");
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+shares/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+file_request/i);
  });
});

describe("client service request listing", () => {
  it("maps a bounded newest-first list only after active identity, account, project, and grant checks", async () => {
    const value = recordingEnv({
      all: () => [{
        id: "request-a",
        project_id: "project-a",
        request_type: "flight",
        title: "Progress flight",
        details: "Capture current site progress.",
        location_text: "Chicago",
        preferred_start_at: null,
        status: "under_review",
        created_at: "2026-07-31 12:00:00",
        updated_at: "2026-07-31 13:00:00",
      }],
    });
    const requests = await d1ClientPortalRepository.listServiceRequests(value.env, session);
    expect(requests).toEqual([{
      id: "request-a",
      projectId: "project-a",
      requestType: "flight",
      title: "Progress flight",
      details: "Capture current site progress.",
      location: "Chicago",
      preferredStartAt: null,
      serviceCategory: null,
      deliverables: null,
      siteContactName: null,
      siteContactEmail: null,
      siteContactPhone: null,
      desiredCompletionAt: null,
      latitude: null,
      longitude: null,
      areaGeoJson: null,
      parentRequestId: undefined,
      poiPoints: [],
      acceptedQuote: null,
      operationalEstimate: null,
      status: "under_review",
      createdAt: "2026-07-31 12:00:00",
      updatedAt: "2026-07-31 13:00:00",
    }]);
    const call = value.calls[0]!;
    expect(call.binds).toEqual(["account-a", "identity-a"]);
    expect(call.sql).toContain("r.account_id=a.id");
    expect(call.sql).toContain("request_grant.account_id=a.id");
    expect(call.sql).toContain("request_grant.revoked_at IS NULL");
    expect(call.sql).toContain("request_project.active=1");
    expect(call.sql).toContain("ORDER BY r.created_at DESC,r.id DESC");
    expect(call.sql).toContain("LIMIT 100");
  });
});

describe("client service request idempotency", () => {
  const input = {
    idempotencyKey: "request-test-0001",
    projectId: "project-a",
    requestType: "service" as const,
    title: "Model refresh",
    details: "Refresh the current site model.",
    location: null,
    preferredStartAt: null,
  };

  async function fingerprint(): Promise<string> {
    return sha256(JSON.stringify([
      input.projectId,
      input.requestType,
      input.title,
      input.details,
      input.location,
      input.preferredStartAt,
    ]));
  }

  function existing(requestFingerprint: string) {
    return {
      id: "request-existing",
      project_id: "project-a",
      request_type: "service",
      title: "Model refresh",
      details: "Refresh the current site model.",
      location_text: null,
      preferred_start_at: null,
      status: "submitted",
      created_at: "2026-07-31 12:00:00",
      updated_at: "2026-07-31 12:00:00",
      request_fingerprint: requestFingerprint,
    };
  }

  it("returns the original request for an exact retry without another write", async () => {
    const expectedFingerprint = await fingerprint();
    const value = recordingEnv({
      changes: () => 0,
      first: call => call.sql.includes("r.idempotency_key=?") ? existing(expectedFingerprint) : null,
    });
    const result = await d1ClientPortalRepository.createServiceRequest(value.env, session, input);
    expect(result).toMatchObject({ kind: "replayed", request: { id: "request-existing" } });
    expect(value.calls).toHaveLength(1);
    expect(value.calls[0]?.binds).toEqual(["account-a", "identity-a", "request-test-0001"]);
    expect(value.calls[0]?.sql).toContain("r.account_id=a.id");
  });

  it("rejects reuse of the key for a different payload", async () => {
    const value = recordingEnv({
      changes: () => 0,
      first: call => call.sql.includes("r.idempotency_key=?") ? existing("x".repeat(43)) : null,
    });
    await expect(d1ClientPortalRepository.createServiceRequest(value.env, session, input))
      .resolves.toEqual({ kind: "conflict" });
  });
});
