import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { writeClientAuthorityWorkspaceBinding } from "../src/worker/client-authority-workspace-binding";
import { writeClientPortalAuthorityV2, writeClientPortalAuthorityV3 } from "../src/worker/client-portal-authority-v2";
import { readOperationsServiceHome, readOperationsServiceHomes, type OperationsServiceHomeEnv } from "../src/worker/client-portal/operations-service-home";
import { CLIENT_PORTAL_SERVICE_METADATA_MAX_RESPONSE_BYTES } from "../../../packages/shared/src/client-portal-service-metadata";

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
    CLIENT_PORTAL_SERVICE_METADATA_READER: { readServiceMetadata: async input => JSON.stringify(await read(input)) } };
}
function wireEnv(read: (input: unknown) => Promise<string>, rows: Array<typeof tuple | null> = [tuple, tuple]): OperationsServiceHomeEnv {
  const base = env(async () => response(), rows);
  return { ...base, CLIENT_PORTAL_SERVICE_METADATA_READER: { readServiceMetadata: read } };
}

describe("Operations service home private helper", () => {
  it("discovers the exact permitted homes and rechecks the complete snapshot", async () => {
    const result = await readOperationsServiceHomes(env(async () => response()), principal);
    expect(result).toEqual({ ok: true, homes: [{ authorityId, workspaceId: "workspace-one",
      ownershipEpoch: 1, grantRevision: 3, services: response().services }] });
    await expect(readOperationsServiceHomes(env(async () => response(), [tuple, tuple, tuple, null]), principal))
      .resolves.toEqual({ ok: false, code: "denied" });
  });

  it("does not fall back when discovery is denied or its transport is missing", async () => {
    const read = vi.fn(async () => response());
    await expect(readOperationsServiceHomes(env(read, [null]), principal)).resolves.toEqual({ ok: false, code: "denied" });
    expect(read).not.toHaveBeenCalled();
    const { CLIENT_PORTAL_SERVICE_METADATA_READER: _reader, ...missing } = env(read);
    await expect(readOperationsServiceHomes(missing, principal)).resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("rejects the entire multi-home result if an earlier home disappears during another read", async () => {
    const second = { ...tuple, authority_id: "22222222-2222-4222-8222-222222222222", workspace_id: "workspace-two" };
    let discovery = 0;
    const statement = (selected?: string) => ({ bind: (...values: unknown[]) => statement(values.length === 3 ? String(values[0]) : undefined),
      all: async () => ({ success: true, results: selected ? [selected === authorityId ? tuple : second]
        : ++discovery === 1 ? [tuple, second] : [second] }) });
    const base = env(async input => {
      const request = input as { authorityId: string; workspaceId: string };
      return response({ authorityId: request.authorityId, workspaceId: request.workspaceId });
    });
    await expect(readOperationsServiceHomes({ ...base,
      DELIVERY_DB: { prepare: () => statement() } as unknown as D1Database }, principal))
      .resolves.toEqual({ ok: false, code: "denied" });
    expect(discovery).toBe(2);
  });

  it("rejects oversized or duplicate discovery snapshots before private calls", async () => {
    const read = vi.fn(async () => response());
    for (const results of [Array.from({ length: 21 }, () => tuple), [tuple, tuple]]) {
      const statement = { bind: () => statement, all: async () => ({ success: true, results }) };
      const base = env(read);
      await expect(readOperationsServiceHomes({ ...base,
        DELIVERY_DB: { prepare: () => statement } as unknown as D1Database }, principal))
        .resolves.toEqual({ ok: false, code: "unavailable" });
    }
    expect(read).not.toHaveBeenCalled();
  });
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
    await expect(readOperationsServiceHome(wireEnv(async () => `${JSON.stringify(response())} `), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(readOperationsServiceHome(wireEnv(async () => "{"), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(readOperationsServiceHome(wireEnv(async () => `"${"é".repeat(151_426)}"`), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    const rawObject = wireEnv(async () => JSON.stringify(response()));
    Reflect.set(rawObject.CLIENT_PORTAL_SERVICE_METADATA_READER!, "readServiceMetadata", async () => response());
    await expect(readOperationsServiceHome(rawObject, principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    const hostileGetter = vi.fn(() => { throw Error("unexpected-object-access"); });
    const hostileObject = Object.defineProperty({}, "services", { get: hostileGetter });
    Reflect.set(rawObject.CLIENT_PORTAL_SERVICE_METADATA_READER!, "readServiceMetadata", async () => hostileObject);
    await expect(readOperationsServiceHome(rawObject, principal, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
    expect(hostileGetter).not.toHaveBeenCalled();
    await expect(readOperationsServiceHome(wireEnv(async () => JSON.stringify({ ...response(), services: [
      { ...response().services[0], extra: true },
    ] })), principal, authorityId)).resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(readOperationsServiceHome(wireEnv(async () => `${JSON.stringify(response())}${" ".repeat(302_851)}`), principal, authorityId))
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

  it("accepts the exact maximum UTF-8 wire and rejects one additional byte", async () => {
    const control = "\u0001", workspaceId = control.repeat(200), issuer = control.repeat(512), subject = control.repeat(512);
    const digits = [1, 2, 3, 4, 5, 6, 7, 14, 15, 16].map(value => String.fromCharCode(value));
    const services = Array.from({ length: 100 }, (_, index) => ({
      serviceId: `${control.repeat(189)}${digits[Math.floor(index / 10)]}${digits[index % 10]}`,
      providerId: control.repeat(128), displayLabel: control.repeat(160), revision: Number.MAX_SAFE_INTEGER,
    }));
    const maxTuple = { authority_id: authorityId, workspace_id: workspaceId,
      ownership_epoch: Number.MAX_SAFE_INTEGER, grant_revision: Number.MAX_SAFE_INTEGER };
    const wire = JSON.stringify({ ok: true, protocolVersion: 1, authorityId, workspaceId,
      ownershipEpoch: Number.MAX_SAFE_INTEGER, grantRevision: Number.MAX_SAFE_INTEGER, issuer, subject, services });
    expect(new TextEncoder().encode(wire).byteLength).toBe(CLIENT_PORTAL_SERVICE_METADATA_MAX_RESPONSE_BYTES);
    const maximum = wireEnv(async () => wire, [maxTuple, maxTuple]);
    await expect(readOperationsServiceHome(maximum, { issuer, subject }, authorityId)).resolves.toMatchObject({ ok: true, services });
    const oversized = wireEnv(async () => `${wire} `, [maxTuple, maxTuple]);
    await expect(readOperationsServiceHome(oversized, { issuer, subject }, authorityId))
      .resolves.toEqual({ ok: false, code: "unavailable" });
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

describe("Operations service home against explicit permission ledger", () => {
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
  const homeGrant = (operationId: string, expectedGrantRevision = 0, permission = true) => {
    const { scopes: _scopes, ...command } = grant(operationId, "active", expectedGrantRevision);
    return { ...command, permissions: permission ? ["operations.service_home.read"] : [] };
  };

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
      "0218_client_authority_workspace_binding.sql", "0219_operations_portal_authority_v2.sql",
      "0220_operations_portal_authority_v3_permissions.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    }
    await writeClientAuthorityWorkspaceBinding({ DELIVERY_DB: db, CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED: "true" }, {
      operationId: bindingOperationId, clientAuthorityId: authorityId, workspaceId: "workspace-one",
      projectionSourceId: "project-alpha:east", sourceWorkspaceId: "source-one", rootType: "organization", rootPublicId: root,
      expectedCheckpoint: { sourceGeneration: "generation-one", sourceSequence: 1, snapshotGenerationId: "snapshot-one" },
    });
    await writeClientPortalAuthorityV3(writerEnv(), homeGrant("grant-one"));
  });
  afterEach(async () => runtime.dispose());

  const realEnv = (read: (input: unknown) => Promise<unknown>): OperationsServiceHomeEnv => ({ DELIVERY_DB: db,
    CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true", CLIENT_PORTAL_SERVICE_METADATA_READER: {
      readServiceMetadata: async input => JSON.stringify(await read(input)),
    } });

  it("returns an exact validated service list and distinguishes the same subject at another issuer", async () => {
    await expect(readOperationsServiceHome(realEnv(async () => response({ grantRevision: 1 })), principal, authorityId)).resolves.toEqual({
      ok: true, authorityId, workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 1,
      services: [{ serviceId: "service-one", providerId: "ltds", displayLabel: "Inspection", revision: 4 }],
    });
    await expect(readOperationsServiceHome(realEnv(async () => response()),
      { issuer: "https://other.example.test", subject: principal.subject }, authorityId))
      .resolves.toEqual({ ok: false, code: "denied" });
  });

  it("never infers home permission from a legacy v2 active enrollment", async () => {
    await writeClientPortalAuthorityV2(writerEnv(), grant("legacy-two", "active", 1));
    const read = vi.fn(async () => response({ grantRevision: 2 }));
    await expect(readOperationsServiceHome(realEnv(read), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "denied" });
    expect(read).not.toHaveBeenCalled();
    await expect(readOperationsServiceHomes(realEnv(read), principal)).resolves.toEqual({ ok: false, code: "denied" });
  });

  it("does not use a historical grant when native discovery is selected but its migration is absent", async () => {
    const read = vi.fn(async () => response({ grantRevision: 1 }));
    const selected = { ...realEnv(read), CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true" };
    await expect(readOperationsServiceHomes(selected, principal)).resolves.toEqual({ ok: false, code: "unavailable" });
    await expect(readOperationsServiceHome(selected, principal, authorityId)).resolves.toEqual({ ok: false, code: "denied" });
    expect(read).not.toHaveBeenCalled();
  });

  it("removes home permission without revoking the inert enrollment", async () => {
    await writeClientPortalAuthorityV3(writerEnv(), homeGrant("remove-two", 1, false));
    expect(await db.prepare("SELECT state FROM portal_operations_principal_grant_heads").first("state")).toBe("active");
    const read = vi.fn(async () => response({ grantRevision: 2 }));
    await expect(readOperationsServiceHome(realEnv(read), principal, authorityId))
      .resolves.toEqual({ ok: false, code: "denied" });
    expect(read).not.toHaveBeenCalled();
    await expect(readOperationsServiceHomes(realEnv(read), principal)).resolves.toEqual({ ok: false, code: "denied" });
  });

  it("drops a result when only the home permission is removed during the RPC", async () => {
    const binding = realEnv(async () => {
      await writeClientPortalAuthorityV3(writerEnv(), homeGrant("remove-two", 1, false));
      return response({ grantRevision: 1 });
    });
    await expect(readOperationsServiceHome(binding, principal, authorityId)).resolves.toEqual({ ok: false, code: "denied" });
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
      await writeClientPortalAuthorityV3(writerEnv(), homeGrant("regrant-three", 2));
      return response({ grantRevision: 1 });
    });
    await expect(readOperationsServiceHome(binding, principal, authorityId)).resolves.toEqual({ ok: false, code: "denied" });
  });
});
