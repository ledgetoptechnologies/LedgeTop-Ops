import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { writeClientAuthorityWorkspaceBinding } from "../src/worker/client-authority-workspace-binding";
import { writeClientPortalAuthorityV2 } from "../src/worker/client-portal-authority-v2";
import { readOperationsServiceHome, type OperationsServiceHomeEnv } from "../src/worker/client-portal/operations-service-home";

const authorityId = "11111111-1111-4111-8111-111111111111";
const principal = { issuer: "https://access.example.test", subject: "person-one" };
const tuple = { authority_id: authorityId, workspace_id: "workspace-one", ownership_epoch: 1, grant_revision: 3 };
const response = (overrides: Record<string, unknown> = {}) => ({ ok: true, protocolVersion: 1, authorityId,
  workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 3, issuer: principal.issuer,
  subject: principal.subject, services: [{ serviceId: "service-one", providerId: "ltds",
    displayLabel: "Inspection", revision: 4 }], ...overrides });

function env(read: (input: unknown) => Promise<unknown>, rows: Array<typeof tuple | null> = [tuple, tuple],
  enabled = "true"): OperationsServiceHomeEnv {
  let index = 0;
  const statement = { bind: () => statement, all: async () => {
    const row = rows[Math.min(index++, rows.length - 1)];
    return { success: true, results: row ? [row] : [] };
  } };
  return { DELIVERY_DB: { withSession: () => ({ prepare: () => statement }) } as unknown as D1Database,
    CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: enabled,
    CLIENT_PORTAL_SERVICE_METADATA_READER: { readServiceMetadata: read } };
}

describe("Operations service home private helper", () => {
  it("rejects missing/disabled bindings before transport", async () => {
    const base = env(async () => response());
    await expect(readOperationsServiceHome({ ...base, CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "false" }, principal, authorityId))
      .resolves.toEqual({ ok: false, code: "disabled" });
    const { CLIENT_PORTAL_SERVICE_METADATA_READER: _reader, ...missing } = base;
    await expect(readOperationsServiceHome(missing, principal, authorityId)).resolves.toEqual({ ok: false, code: "disabled" });
  });

  it("uses the exact issuer and subject and never matches a same-subject issuer", async () => {
    const called = vi.fn(async () => response());
    const denied = env(called, [null]);
    await expect(readOperationsServiceHome(denied, { ...principal, issuer: "https://other.example.test" }, authorityId))
      .resolves.toEqual({ ok: false, code: "denied" });
    expect(called).not.toHaveBeenCalled();
  });

  it("fails closed when local authority is lost during the RPC", async () => {
    await expect(readOperationsServiceHome(env(async () => response(), [tuple, null]), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "denied" });
  });

  it("rejects malformed and cross-tuple success responses", async () => {
    await expect(readOperationsServiceHome(env(async () => ({ ...response(), extra: true })), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    const accessor = response();
    Object.defineProperty(accessor, "services", { enumerable: true, get: () => [] });
    await expect(readOperationsServiceHome(env(async () => accessor), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(readOperationsServiceHome(env(async () => response({ workspaceId: "other" })), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    const duplicate = response({ services: [response().services[0], response().services[0]] });
    await expect(readOperationsServiceHome(env(async () => duplicate), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("maps an exact denied Operations response to denied", async () => {
    const denied = { ok: false, protocolVersion: 1, authorityId, workspaceId: "workspace-one", ownershipEpoch: 1,
      grantRevision: 3, issuer: principal.issuer, subject: principal.subject, code: "denied" };
    await expect(readOperationsServiceHome(env(async () => denied), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "denied" });
  });

  it("bounds a hung transport as unavailable", async () => {
    vi.useFakeTimers();
    try {
      const pending = readOperationsServiceHome(env(() => new Promise(() => undefined)), principal, authorityId);
      await vi.advanceTimersByTimeAsync(1_501);
      await expect(pending).resolves.toEqual({ ok: false, code: "unavailable" });
    } finally { vi.useRealTimers(); }
  });
});

describe("Operations service home against 0218/0219", () => {
  let runtime: Miniflare;
  let db: D1Database;
  const bindingOperationId = "binding-operation-one";
  const root = "a".repeat(32);
  const writerEnv = () => ({ DELIVERY_DB: db, CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED: "true" });
  const grant = (operationId: string, desiredState: "active" | "revoked" = "active", expectedGrantRevision = 0) => ({
    operationId, clientAuthorityId: authorityId, workspaceId: "workspace-one", bindingOperationId,
    issuer: principal.issuer, subject: principal.subject, desiredState,
    expectedOwnershipEpoch: desiredState === "active" && expectedGrantRevision === 0 ? 0 : 1,
    expectedGrantRevision, scopes: [] as [],
  });

  beforeEach(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { DELIVERY_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT,status TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT)"),
      db.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,projection_source_id TEXT,workspace_root_type TEXT,workspace_root_public_id TEXT)"),
      db.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT,source_sequence INTEGER,snapshot_generation_id TEXT)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-one','organization',?,NULL,'project-alpha:east','active')").bind(root),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES('workspace-one','project-alpha:east','source-one')"),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-one','workspace-one','generation-one',1,'project-alpha:east','organization',?)").bind(root),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES('workspace-one','generation-one',1,'snapshot-one')"),
    ]);
    for (const migration of ["0216_client_authority_workspace_ownership_claim.sql", "0217_client_authority_workspace_claim_evidence.sql",
      "0218_client_authority_workspace_binding.sql", "0219_operations_portal_authority_v2.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    }
    await writeClientAuthorityWorkspaceBinding({ DELIVERY_DB: db, CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED: "true" }, {
      operationId: bindingOperationId, clientAuthorityId: authorityId, workspaceId: "workspace-one",
      projectionSourceId: "project-alpha:east", sourceWorkspaceId: "source-one", rootType: "organization", rootPublicId: root,
      expectedCheckpoint: { sourceGeneration: "generation-one", sourceSequence: 1, snapshotGenerationId: "snapshot-one" },
    });
    await writeClientPortalAuthorityV2(writerEnv(), grant("grant-one"));
  });
  afterEach(async () => runtime.dispose());

  const realEnv = (read: (input: unknown) => Promise<unknown>): OperationsServiceHomeEnv => ({ DELIVERY_DB: db,
    CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true", CLIENT_PORTAL_SERVICE_METADATA_READER: { readServiceMetadata: read } });

  it("returns an exact validated service list and distinguishes the same subject at another issuer", async () => {
    await expect(readOperationsServiceHome(realEnv(async () => response({ grantRevision: 1 })), principal, authorityId)).resolves.toEqual({
      ok: true, authorityId, workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 1,
      services: [{ serviceId: "service-one", providerId: "ltds", displayLabel: "Inspection", revision: 4 }],
    });
    await expect(readOperationsServiceHome(realEnv(async () => response()),
      { issuer: "https://other.example.test", subject: principal.subject }, authorityId))
      .resolves.toEqual({ ok: false, code: "denied" });
  });

  it("drops a result when the exact grant is revoked during the RPC", async () => {
    const binding = realEnv(async () => {
      await writeClientPortalAuthorityV2(writerEnv(), grant("revoke-two", "revoked", 1));
      return response({ grantRevision: 1 });
    });
    await expect(readOperationsServiceHome(binding, principal, authorityId)).resolves.toEqual({ ok: false, code: "denied" });
  });

  it("drops an old response when the grant is revoked and regranted during the RPC", async () => {
    const binding = realEnv(async () => {
      await writeClientPortalAuthorityV2(writerEnv(), grant("revoke-two", "revoked", 1));
      await writeClientPortalAuthorityV2(writerEnv(), grant("regrant-three", "active", 2));
      return response({ grantRevision: 1 });
    });
    await expect(readOperationsServiceHome(binding, principal, authorityId)).resolves.toEqual({ ok: false, code: "denied" });
  });
});
