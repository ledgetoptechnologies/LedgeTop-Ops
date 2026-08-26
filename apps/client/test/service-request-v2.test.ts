import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { createClientPortalRouter } from "../src/worker/client-portal/routes";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { d1ClientPortalRepository } from "../src/worker/client-portal/repository";
import { sha256 } from "../src/worker/security";
import { getAuthorizedRequestAttachment, getSubmittedRequestAttachment, listRequestAttachments, listSubmittedRequestAttachments } from "../src/worker/client-portal/request-attachments";
import { validateRequestArea } from "../src/worker/client-portal/request-area";
import {
  calculateRequestAreaSquareMeters,
  createServiceRequestDraft,
  getServiceRequestDraft,
  listServiceCatalog,
  listServiceRequestDrafts,
  saveServiceRequestDraft,
  sanitizeServiceQuestions,
  submitServiceRequestDraft,
  validateServiceAnswers,
} from "../src/worker/client-portal/request-v2";
import type {
  ClientPortalRepository,
  ClientPortalSession,
  ClientServiceRequestDraft,
  ClientServiceRequestDraftInput,
  ResolveClientPrincipal,
} from "../src/worker/client-portal/types";
import type { Env } from "../src/worker/types";

const session: ClientPortalSession = {
  accountId: "account-a", identityId: "identity-a", displayName: "Acme",
  role: "manager", canViewBilling: false,
};
const principal: ResolveClientPrincipal = vi.fn(async () => ({
  issuer: "https://identity.example", subject: "client-user-1", email: "client@example.com",
}));
const polygon = {
  type: "Polygon" as const,
  coordinates: [[[-88, 44], [-87.99, 44], [-87.99, 44.01], [-88, 44.01], [-88, 44]]] as [number, number][][],
};
const service = {
  publicId: "svc-mapping", sourceVersion: "v7", name: "2D Mapping", summary: "Orthomosaic mapping",
  category: "Mapping", displayOrder: 10, geometryRequirement: "required" as const,
  questions: [{ id: "resolution", label: "Resolution", type: "select" as const, required: true, helpText: null, options: [{ value: "standard", label: "Standard" }] }],
  answers: { resolution: "standard" },
};
const draft: ClientServiceRequestDraft = {
  id: "draft-a", state: "draft", version: 2, projectId: "project-a", requestType: "service",
  title: "Map the site", details: "Capture the current construction area.", location: null,
  preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
  siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null,
  areaGeoJson: polygon, poiPoints: [], areaSquareMeters: 889_000, areaAcres: 219.7,
  services: [service], submittedRequestId: null, createdAt: "2026-08-13 12:00:00", updatedAt: "2026-08-13 12:01:00",
};

function repository(overrides: Partial<ClientPortalRepository> = {}): ClientPortalRepository {
  return {
    resolveSession: vi.fn(async () => session), listProjects: vi.fn(async () => []), getProject: vi.fn(async () => null),
    listProjectFiles: vi.fn(async () => null), listPastDeliveries: vi.fn(async () => ({ files: [], prefix: "", cursor: null })),
    listProjectFileLocations: vi.fn(async () => null), listPastDeliveryLocations: vi.fn(async () => ({ points: [], imageCount: 0, truncated: false })),
    getAuthorizedFile: vi.fn(async () => null), listDeliveries: vi.fn(async () => []), getDeliveryHandoff: vi.fn(async () => null),
    listNotifications: vi.fn(async () => ({ notifications: [], unreadCount: 0, cursor: null })), updateNotification: vi.fn(async () => false),
    listServiceRequests: vi.fn(async () => []), getServiceRequest: vi.fn(async () => null), createServiceRequest: vi.fn(async () => null),
    updateServiceRequest: vi.fn(async () => null), createChangeRequest: vi.fn(async () => null), listMembers: vi.fn(async () => []),
    listInvitations: vi.fn(async () => []), createInvitation: vi.fn(async () => null), revokeMember: vi.fn(async () => false), revokeInvitation: vi.fn(async () => false),
    ...overrides,
  };
}

const env = {
  CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_REQUEST_V2_ENABLED: "true", CLIENT_PORTAL_ORIGIN: "https://client.example", ENVIRONMENT: "development",
} as Env;
const draftBody = {
  projectId: "project-a", requestType: "service", title: "Map the site", details: "Capture the current construction area.",
  location: null, preferredStartAt: null, deliverables: null, siteContactName: null, siteContactEmail: null,
  siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null, areaGeoJson: polygon, poiPoints: [],
  services: [{ publicId: "svc-mapping", sourceVersion: "v7", answers: { resolution: "standard" } }],
};

describe("service request v2 validation", () => {
  it("computes authoritative square meters from the validated Mapbox polygon", () => {
    const area = calculateRequestAreaSquareMeters(polygon);
    expect(area).toBeGreaterThan(880_000);
    expect(area).toBeLessThan(900_000);
    expect(calculateRequestAreaSquareMeters(null)).toBeNull();
  });

  it.each([
    { latitude: 0, expectedSquareMeters: 12_363_718_145 },
    { latitude: 45, expectedSquareMeters: 8_666_174_571 },
    { latitude: 80, expectedSquareMeters: 2_040_679_782 },
  ])("matches the spherical area of a one-degree bounded rectangle at $latitude degrees", ({ latitude, expectedSquareMeters }) => {
    const rectangle = {
      type: "Polygon" as const,
      coordinates: [[[0, latitude], [1, latitude], [1, latitude + 1], [0, latitude + 1], [0, latitude]]] as [number, number][][],
    };
    expect(calculateRequestAreaSquareMeters(validateRequestArea(rectangle))).toBeCloseTo(expectedSquareMeters, -3);
  });

  it("accepts only sanitized catalog questions and schema-conforming answers", () => {
    const questions = sanitizeServiceQuestions(service.questions)!;
    expect(validateServiceAnswers(questions, { resolution: "standard" })).toEqual({ resolution: "standard" });
    expect(validateServiceAnswers(questions, {}, true)).toEqual({});
    expect(validateServiceAnswers(questions, {})).toBeNull();
    expect(validateServiceAnswers(questions, { resolution: "premium" })).toBeNull();
    expect(validateServiceAnswers(questions, { resolution: "standard", injected: "value" })).toBeNull();
    expect(sanitizeServiceQuestions([{ ...service.questions[0], label: "unsafe\u0000label" }])).toBeNull();
  });
});

describe("service request v2 transaction-time catalog contract", () => {
  let miniflare: Miniflare;
  let database: D1Database;
  let repositoryEnv: Env;
  const input: ClientServiceRequestDraftInput = { ...draftBody, requestType: "service" };
  const tables = ["client_service_request_drafts", "client_service_request_draft_services",
    "client_service_request_draft_mutations", "client_service_requests", "client_service_request_services",
    "request_revisions", "client_portal_notification_outbox", "audit_log"] as const;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "request-v2-catalog-races" } });
    database = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    // Use the deployed constraints, indexes and attachment triggers, not a
    // permissive mock schema that could hide partial submission side effects.
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8"));
      if (statements.length) await database.batch(statements.map(statement => database.prepare(statement)));
    }
    await database.batch([
      database.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id) VALUES('account-a','Acme','active','same-org-id','project-alpha:primary'),('account-secondary','Other instance','active','same-org-id','project-alpha:secondary')"),
      database.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('identity-a','account-a','https://issuer.test','subject-a','client@example.test')"),
      database.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account-a','identity-a','manager')"),
      database.prepare("INSERT INTO projects(id,client_name,project_name,r2_prefix,active,project_alpha_project_id,project_alpha_source_id) VALUES('project-a','Acme','Site mapping','Clients/Acme/Mapping/',1,'same-project-id','project-alpha:primary'),('project-secondary','Other instance','Secondary mapping','Secondary/Mapping/',1,'same-project-id','project-alpha:secondary')"),
      database.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES('account-a','project-a',1)"),
      database.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('identity-secondary','account-secondary','https://issuer.test','secondary-user','secondary@example.test')"),
      database.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account-secondary','identity-secondary','manager')"),
      database.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES('account-secondary','project-secondary',1)"),
    ]);
    repositoryEnv = { DELIVERY_DB: database } as Env;
  }, 60_000);

  afterAll(async () => miniflare.dispose());

  beforeEach(async () => {
    await database.batch([
      database.prepare("DELETE FROM client_service_request_drafts"),
      database.prepare("DELETE FROM client_service_requests"),
      database.prepare("DELETE FROM audit_log"),
      database.prepare("DELETE FROM pa_service_catalog_items"),
      database.prepare("UPDATE client_project_grants SET can_request_service=1,revoked_at=NULL"),
      database.prepare(`INSERT INTO pa_service_catalog_items
        (public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
        VALUES(?,?,?,?,?,?,?,?,1,'2026-08-25T12:00:00Z')`)
        .bind(service.publicId, service.sourceVersion, service.name, service.summary, service.category, service.displayOrder,
          service.geometryRequirement, JSON.stringify(service.questions)),
    ]);
  });

  function beforeTransaction(action: () => Promise<unknown>): Env {
    let pending = true;
    const wrapped = new Proxy(database, {
      get(target, property) {
        if (property === "withSession") return () => wrapped;
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          if (pending) { pending = false; await action(); }
          return target.batch(statements);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ...repositoryEnv, DELIVERY_DB: wrapped };
  }

  async function createdDraft(): Promise<ClientServiceRequestDraft> {
    const result = await createServiceRequestDraft(repositoryEnv, session, input, "initial-draft-key-0001");
    expect(result?.kind).toBe("created");
    if (!result || !("draft" in result)) throw new Error("Expected a created draft");
    return result.draft;
  }

  async function requestState() {
    const results = await database.batch(tables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`)));
    return results.map(result => result.results);
  }

  async function changeCatalog(kind: "deactivated" | "version_changed", publicId = service.publicId) {
    await database.prepare("UPDATE pa_service_catalog_items SET active=0 WHERE source_id=? AND public_id=?").bind(PRIMARY_ALPHA_SOURCE_ID, publicId).run();
    if (kind === "version_changed") {
      await database.prepare(`INSERT INTO pa_service_catalog_items
        (public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
        SELECT public_id,'v8',name,summary,category,display_order,geometry_requirement,question_schema_json,1,'2026-08-25T13:00:00Z'
        FROM pa_service_catalog_items WHERE source_id=? AND public_id=? AND source_version='v7'`).bind(PRIMARY_ALPHA_SOURCE_ID, publicId).run();
    }
  }

  const otherSource = "project-alpha:other";
  async function seedOtherCatalog(publicId = service.publicId) {
    await database.prepare(`INSERT INTO pa_service_catalog_items
      (source_id,public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
      VALUES(?,?,'v7','Other-source confidential service','Other-source summary','Mapping',10,'required',?,1,'2026-08-25T12:00:00Z')`)
      .bind(otherSource, publicId, JSON.stringify(service.questions)).run();
  }

  async function seedOtherDraft(empty = false) {
    const original = await createdDraft();
    await database.prepare(`INSERT INTO client_service_request_drafts
      (id,account_id,project_id,created_by_identity_id,draft_json,area_geojson,area_square_meters,area_acres,create_idempotency_key,create_fingerprint,last_mutation_key,catalog_source_id)
      SELECT 'draft-other',account_id,project_id,created_by_identity_id,draft_json,area_geojson,area_square_meters,area_acres,
        'other-draft-create-key',create_fingerprint,'other-draft-save-key',? FROM client_service_request_drafts WHERE id=?`)
      .bind(otherSource, original.id).run();
    if (!empty) await database.prepare(`INSERT INTO client_service_request_draft_services
      (draft_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
      SELECT 'draft-other',ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,?
      FROM client_service_request_draft_services WHERE draft_id=?`).bind(otherSource, original.id).run();
    await database.prepare(`INSERT INTO client_service_request_draft_mutations
      (draft_id,mutation_key,mutation_fingerprint,resulting_version,result_snapshot_json)
      VALUES('draft-other','other-draft-save-key',?,1,'{"version":1}')`).bind(await sha256(JSON.stringify(input))).run();
    return original;
  }

  async function seedOtherRequest(status = "submitted") {
    await database.prepare(`INSERT INTO client_service_requests
      (id,account_id,project_id,created_by_identity_id,request_type,title,details,status,idempotency_key,request_fingerprint,catalog_source_id)
      VALUES('request-other','account-a','project-a','identity-a','service','Private other-source request','Other-source details',?,
        'other-request-create-key',?,?)`).bind(status, "f".repeat(43), otherSource).run();
  }

  it("does not route secondary Delivery parents with identical Alpha references into primary catalog requests", async () => {
    const secondary={...session,accountId:"account-secondary",identityId:"identity-secondary"};
    for(const projectId of [null,"project-secondary"]) {
      expect(await createServiceRequestDraft(repositoryEnv,secondary,{...input,projectId,services:[]},`secondary-empty-${projectId??"root"}`)).toBeNull();
      expect(await createServiceRequestDraft(repositoryEnv,secondary,{...input,projectId},`secondary-review-${projectId??"root"}`)).toBeNull();
    }
    expect(await listServiceRequestDrafts(repositoryEnv,secondary)).toEqual([]);
    expect(await d1ClientPortalRepository.listServiceRequests(repositoryEnv,secondary)).toEqual([]);
    expect(await database.prepare("SELECT count(*) n FROM client_service_request_drafts").first("n")).toBe(0);
    expect((await createdDraft()).projectId).toBe("project-a");
  });

  it("keeps primary selections and saved JSON stable when another source uses identical service IDs and versions", async () => {
    await seedOtherCatalog();
    await seedOtherCatalog("only-other-service");
    const { answers: _answers, ...catalogItem } = service;
    expect(await listServiceCatalog(repositoryEnv)).toEqual([catalogItem]);
    const original = await createdDraft();
    expect(original.services).toEqual([service]);
    const parent = await database.prepare("SELECT catalog_source_id,create_fingerprint FROM client_service_request_drafts WHERE id=?").bind(original.id).first<{ catalog_source_id: string; create_fingerprint: string }>();
    expect(parent).toEqual({ catalog_source_id: PRIMARY_ALPHA_SOURCE_ID, create_fingerprint: await sha256(JSON.stringify(input)) });
    const child = await database.prepare("SELECT service_source_id,service_snapshot_json,answers_json FROM client_service_request_draft_services WHERE draft_id=?").bind(original.id).first<{ service_source_id: string; service_snapshot_json: string; answers_json: string }>();
    expect(child?.service_source_id).toBe(PRIMARY_ALPHA_SOURCE_ID);
    expect(JSON.parse(child!.service_snapshot_json)).toEqual(catalogItem);
    const submitted = await submitServiceRequestDraft(repositoryEnv, session, original.id, original.version, "primary-provenance-submit");
    expect(submitted?.kind).toBe("submitted");
    if (!submitted || !("request" in submitted)) throw new Error("Expected submitted request");
    expect(await database.prepare("SELECT catalog_source_id FROM client_service_requests WHERE id=?").bind(submitted.request.id).first("catalog_source_id")).toBe(PRIMARY_ALPHA_SOURCE_ID);
    expect(await database.prepare("SELECT service_source_id,service_snapshot_json,answers_json FROM client_service_request_services WHERE request_id=?").bind(submitted.request.id).first()).toEqual(child);
    const before = await requestState();
    await changeCatalog("deactivated");
    expect((await createServiceRequestDraft(repositoryEnv, session, input, "initial-draft-key-0001"))?.kind).toBe("replayed");
    expect((await submitServiceRequestDraft(repositoryEnv, session, original.id, original.version, "primary-provenance-submit"))?.kind).toBe("replayed");
    expect(await requestState()).toEqual(before);
  });

  it.each([false, true])("denies direct other-source draft reads, saves and replay even when selections are empty=%s", async empty => {
    const primary = await seedOtherDraft(empty);
    const before = await requestState();
    expect((await listServiceRequestDrafts(repositoryEnv, session)).map(row => row.id)).toEqual([primary.id]);
    expect(await getServiceRequestDraft(repositoryEnv, session, "draft-other")).toBeNull();
    expect(await createServiceRequestDraft(repositoryEnv, session, input, "other-draft-create-key")).toBeNull();
    expect(await saveServiceRequestDraft(repositoryEnv, session, "draft-other", 1, input, "other-draft-save-key")).toBeNull();
    expect(await saveServiceRequestDraft(repositoryEnv, session, "draft-other", 1, { ...input, services: [] }, "new-other-save-key")).toBeNull();
    expect(await submitServiceRequestDraft(repositoryEnv, session, "draft-other", 1, "other-submit-key")).toBeNull();
    expect(await requestState()).toEqual(before);
  });

  it("does not resolve a service that exists only in another source", async () => {
    await seedOtherCatalog("only-other-service");
    const before = await requestState();
    expect(await createServiceRequestDraft(repositoryEnv, session, { ...input, services: [{ ...input.services[0]!, publicId: "only-other-service" }] }, "other-only-selection-key"))
      .toEqual({ kind: "catalog_changed", servicePublicIds: ["only-other-service"] });
    expect(await requestState()).toEqual(before);
  });

  it("hides other-source submitted history, mutations and legacy parent change requests", async () => {
    const original = await createdDraft();
    const submitted = await submitServiceRequestDraft(repositoryEnv, session, original.id, original.version, "history-primary-submit");
    if (!submitted || !("request" in submitted)) throw new Error("Expected submitted request");
    await seedOtherRequest();
    expect((await d1ClientPortalRepository.listServiceRequests(repositoryEnv, session)).map(row => row.id)).toEqual([submitted.request.id]);
    expect(await d1ClientPortalRepository.getServiceRequest(repositoryEnv, session, "request-other")).toBeNull();
    const legacyInput = { ...input, idempotencyKey: "legacy-other-change-key", expectedUpdatedAt: "2026-08-25 12:00:00" };
    const before = await requestState();
    expect(await d1ClientPortalRepository.updateServiceRequest(repositoryEnv, session, "request-other", legacyInput)).toBeNull();
    expect(await requestState()).toEqual(before);
    await database.prepare("UPDATE client_service_requests SET status='under_review' WHERE id='request-other'").run();
    const beforeChange = await requestState();
    expect(await d1ClientPortalRepository.createChangeRequest(repositoryEnv, session, "request-other", legacyInput)).toBeNull();
    expect(await d1ClientPortalRepository.createServiceRequest(repositoryEnv, session, { ...legacyInput, parentRequestId: "request-other" })).toBeNull();
    expect(await requestState()).toEqual(beforeChange);
  });

  it("does not replay a primary draft through an other-source submitted request pointer", async () => {
    const original = await createdDraft();
    const key = "primary-pointer-submit";
    expect((await submitServiceRequestDraft(repositoryEnv, session, original.id, original.version, key))?.kind).toBe("submitted");
    await seedOtherRequest();
    await database.prepare("UPDATE client_service_request_drafts SET submitted_request_id='request-other' WHERE id=?").bind(original.id).run();
    expect(await submitServiceRequestDraft(repositoryEnv, session, original.id, original.version, key)).toBeNull();
  });

  it("does not expose attachment metadata from another source's draft or submitted request", async () => {
    await seedOtherDraft(true);
    await seedOtherRequest();
    await database.prepare(`INSERT INTO client_service_request_attachments
      (id,draft_id,account_id,created_by_identity_id,client_upload_id,object_key,multipart_upload_id,original_name,declared_size,content_type,status,expires_at)
      VALUES('attachment-other','draft-other','account-a','identity-a','other-attachment-upload','_ltds/quarantine/request-attachments/other/object',
        'upload-other','Private other-source attachment.pdf',10,'application/pdf','uploading',datetime('now','+1 day'))`).run();
    expect(await listRequestAttachments(repositoryEnv, session, "draft-other")).toBeNull();
    expect(await getAuthorizedRequestAttachment(repositoryEnv, session, "draft-other", "attachment-other")).toBeNull();
    expect(await listSubmittedRequestAttachments(repositoryEnv, session, "request-other")).toBeNull();
    expect(await getSubmittedRequestAttachment(repositoryEnv, session, "request-other", "attachment-other")).toBeNull();
  });

  it("does not invoke the primary pricing connector for an other-source draft", async () => {
    await seedOtherDraft(true);
    const pricingHintProvider = vi.fn();
    const app = createClientPortalRouter({ resolvePrincipal: principal, pricingHintProvider,
      repository: { ...d1ClientPortalRepository, resolveSession: vi.fn(async () => session) } });
    const response = await app.request("https://client.example/service-request-drafts/draft-other/pricing-hint", {}, { ...env, ...repositoryEnv });
    expect(response.status).toBe(404);
    expect(pricingHintProvider).not.toHaveBeenCalled();
  });

  for (const operation of ["create", "save", "submit"] as const) {
    it.each(["deactivated", "version_changed"] as const)(`rejects a %s service changed between ${operation} review and transaction without partial writes`, async change => {
      const original = operation === "create" ? null : await createdDraft();
      // An identical active item in another source must never satisfy the
      // primary transaction guard after the reviewed primary item changes.
      await seedOtherCatalog();
      const before = await requestState();
      const mutationKey = `catalog-${operation}-race-0001`;
      const changedInput = { ...input, title: "Updated mapping request" };
      const raceEnv = beforeTransaction(() => changeCatalog(change));
      const mutate = (target: Env) => operation === "create"
        ? createServiceRequestDraft(target, session, input, mutationKey)
        : operation === "save"
          ? saveServiceRequestDraft(target, session, original!.id, original!.version, changedInput, mutationKey)
          : submitServiceRequestDraft(target, session, original!.id, original!.version, mutationKey);
      expect(await mutate(raceEnv)).toEqual(operation === "submit"
        ? { kind: "incomplete", reason: "catalog_changed", servicePublicIds: [service.publicId] }
        : { kind: "catalog_changed", servicePublicIds: [service.publicId] });
      expect(await requestState()).toEqual(before);
      // A rejected transaction consumes neither the optimistic version nor the
      // idempotency key. The exact reviewed version can still be retried safely.
      await database.batch([
        database.prepare("DELETE FROM pa_service_catalog_items WHERE source_version='v8'"),
        database.prepare("UPDATE pa_service_catalog_items SET active=1 WHERE source_version='v7'"),
      ]);
      expect((await mutate(repositoryEnv))?.kind).toBe(operation === "create" ? "created" : operation === "save" ? "updated" : "submitted");
      const after = await requestState();
      await changeCatalog(change);
      expect((await mutate(repositoryEnv))?.kind).toBe("replayed");
      expect(await requestState()).toEqual(after);
      expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    });
  }

  it("checks every reviewed service at the ten-selection boundary, not just the first", async () => {
    const services = Array.from({ length: 10 }, (_, index) => ({ ...input.services[0]!, publicId: `svc-mapping-${index}` }));
    await database.batch(services.map(selected => database.prepare(`INSERT INTO pa_service_catalog_items
      (public_id,source_version,name,category,geometry_requirement,question_schema_json,active,source_updated_at)
      VALUES(?,'v7','Mapping','Mapping','required',?,1,'2026-08-25T12:00:00Z')`).bind(selected.publicId, JSON.stringify(service.questions))));
    const boundedInput = { ...input, services };
    const before = await requestState();
    expect(await createServiceRequestDraft(beforeTransaction(() => changeCatalog("version_changed", services[9]!.publicId)), session,
      boundedInput, "catalog-ten-services-0001")).toEqual({ kind: "catalog_changed", servicePublicIds: [services[9]!.publicId] });
    expect(await requestState()).toEqual(before);
  });

  it("allows an empty autosave but keeps submission incomplete", async () => {
    const result = await createServiceRequestDraft(repositoryEnv, session, { ...input, services: [] }, "empty-draft-create-0001");
    expect(result?.kind).toBe("created");
    if (!result || !("draft" in result)) throw new Error("Expected draft");
    expect(await submitServiceRequestDraft(repositoryEnv, session, result.draft.id, result.draft.version, "empty-draft-submit-0001"))
      .toEqual({ kind: "incomplete", reason: "answers_incomplete", servicePublicIds: [] });
  });

  it("does not turn a current catalog into permission to submit after the project grant changes", async () => {
    const original = await createdDraft();
    const before = await requestState();
    const result = await submitServiceRequestDraft(beforeTransaction(() => database.prepare("UPDATE client_project_grants SET can_request_service=0").run()),
      session, original.id, original.version, "catalog-grant-submit-0001");
    expect(result).toEqual({ kind: "conflict" });
    expect(await requestState()).toEqual(before);
    expect((await getServiceRequestDraft(repositoryEnv, session, original.id))?.state).toBe("draft");
  });

  it("preserves the optimistic version conflict with an unchanged reviewed catalog", async () => {
    const original = await createdDraft();
    expect((await saveServiceRequestDraft(repositoryEnv, session, original.id, original.version, { ...input, title: "Saved first" }, "catalog-first-save-0001"))?.kind).toBe("updated");
    const before = await requestState();
    expect(await saveServiceRequestDraft(repositoryEnv, session, original.id, original.version, { ...input, title: "Stale save" }, "catalog-stale-save-0001"))
      .toEqual({ kind: "conflict" });
    expect(await submitServiceRequestDraft(repositoryEnv, session, original.id, original.version, "catalog-stale-submit-0001"))
      .toEqual({ kind: "conflict" });
    expect(await requestState()).toEqual(before);
  });
});

describe("service request v2 routes", () => {
  it("lists only the repository's authorized resumable drafts", async () => {
    const summaries = [{
      id: "draft-a", projectId: "project-a", title: "Map the site",
      serviceNames: ["2D Mapping"], areaAcres: 219.7, updatedAt: "2026-08-13 12:01:00",
    }];
    const list = vi.fn(async () => summaries);
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ listServiceRequestDrafts: list }) });
    const response = await app.request("https://client.example/service-request-drafts", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drafts: summaries });
    expect(list).toHaveBeenCalledWith(expect.anything(), session);
  });

  it("autosaves with optimistic versioning and rejects browser-computed money or area", async () => {
    const save = vi.fn(async () => ({ kind: "updated" as const, draft: { ...draft, version: 3 } }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ saveServiceRequestDraft: save }) });
    const response = await app.request("https://client.example/service-request-drafts/draft-a", {
      method: "PUT", headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-save-00000001", "If-Match": "2" },
      body: JSON.stringify(draftBody),
    }, env);
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith(expect.anything(), session, "draft-a", 2, expect.objectContaining({ areaGeoJson: polygon }), "draft-save-00000001");

    const injected = await app.request("https://client.example/service-request-drafts/draft-a", {
      method: "PUT", headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-save-00000002", "If-Match": "2" },
      body: JSON.stringify({ ...draftBody, areaAcres: 1, priceMinor: 1 }),
    }, env);
    expect(injected.status).toBe(400);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("returns a typed catalog drift response for create and save", async () => {
    const catalogChanged = {
      kind: "catalog_changed" as const,
      servicePublicIds: ["svc-mapping"],
    };
    const create = vi.fn(async () => catalogChanged);
    const save = vi.fn(async () => catalogChanged);
    const app = createClientPortalRouter({
      resolvePrincipal: principal,
      repository: repository({ createServiceRequestDraft: create, saveServiceRequestDraft: save }),
    });
    const createResponse = await app.request("https://client.example/service-request-drafts", {
      method: "POST",
      headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-create-drift-0001" },
      body: JSON.stringify(draftBody),
    }, env);
    expect(createResponse.status).toBe(409);
    expect(await createResponse.json()).toEqual({
      error: expect.any(String),
      code: "catalog_changed",
      servicePublicIds: ["svc-mapping"],
    });

    const saveResponse = await app.request("https://client.example/service-request-drafts/draft-a", {
      method: "PUT",
      headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-save-drift-0001", "If-Match": "2" },
      body: JSON.stringify(draftBody),
    }, env);
    expect(saveResponse.status).toBe(409);
    expect(await saveResponse.json()).toMatchObject({ code: "catalog_changed", servicePublicIds: ["svc-mapping"] });
  });

  it("enforces at most ten unique Project Alpha service ids", async () => {
    const create = vi.fn();
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ createServiceRequestDraft: create }) });
    const response = await app.request("https://client.example/service-request-drafts", {
      method: "POST", headers: { Origin: "https://client.example", "Content-Type": "application/json", "Idempotency-Key": "draft-create-000001" },
      body: JSON.stringify({ ...draftBody, services: [draftBody.services[0], draftBody.services[0]] }),
    }, env);
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps pricing unavailable without an authorized v2 workspace/project context", async () => {
    const getServiceRequestDraft = vi.fn(async () => draft);
    const provider = vi.fn(async () => ({ kind: "starting_at" as const, currency: "USD", startingAtMinor: 150_000, disclaimer: "Final quote after review.", basisVersion: "pricing-v3", validUntil: "2026-08-13T13:00:00.000Z" }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ getServiceRequestDraft }), pricingHintProvider: provider });
    const response = await app.request("https://client.example/service-request-drafts/draft-a/pricing-hint", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false, hint: null });
    expect(provider).not.toHaveBeenCalled();
  });

  it("submits with version and idempotency headers and preserves replay status", async () => {
    const request = {
      id: "request-a", projectId: "project-a", requestType: "service" as const, title: draft.title, details: draft.details,
      location: null, preferredStartAt: null, serviceCategory: "2D Mapping", deliverables: null, siteContactName: null,
      siteContactEmail: null, siteContactPhone: null, desiredCompletionAt: null, latitude: null, longitude: null,
      status: "submitted" as const, createdAt: "2026-08-13 12:02:00", updatedAt: "2026-08-13 12:02:00",
    };
    const submit = vi.fn(async () => ({ kind: "replayed" as const, request }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ submitServiceRequestDraft: submit }) });
    const response = await app.request("https://client.example/service-request-drafts/draft-a/submit", {
      method: "POST", headers: { Origin: "https://client.example", "Idempotency-Key": "draft-submit-000001", "If-Match": "2" },
    }, env);
    expect(response.status).toBe(200);
    expect(submit).toHaveBeenCalledWith(expect.anything(), session, "draft-a", 2, "draft-submit-000001");
  });

  it.each([
    ["answers_incomplete", { servicePublicIds: ["svc-mapping"] as string[] }],
    ["geometry_required", { servicePublicIds: ["svc-mapping"] as string[] }],
    ["catalog_changed", { servicePublicIds: ["svc-mapping"] as string[] }],
    ["attachments_pending", { attachmentCount: 2 }],
    ["attachments_rejected", { attachmentCount: 1 }],
    ["attachments_expired", { attachmentCount: 1 }],
  ] as const)("returns a safe typed %s submit block", async (reason, details) => {
    const submit = vi.fn(async () => ({ kind: "incomplete" as const, reason, ...details }));
    const app = createClientPortalRouter({ resolvePrincipal: principal, repository: repository({ submitServiceRequestDraft: submit }) });
    const response = await app.request("https://client.example/service-request-drafts/draft-a/submit", {
      method: "POST",
      headers: { Origin: "https://client.example", "Idempotency-Key": `draft-submit-${reason}-0001`, "If-Match": "2" },
    }, env);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.any(String), code: reason, ...details });
  });
});
