import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ sourceProof: vi.fn(), homes: vi.fn(), nativeContext: vi.fn() }));
vi.mock("../src/worker/project-alpha-portal-authority", () => ({ readPortalProjectionSourceProof: mocks.sourceProof }));
vi.mock("../src/worker/client-portal/operations-native-recipient-read", () => ({ readNativeOperationsPortalHomes: mocks.homes }));
vi.mock("../src/worker/client-portal/workspace-v2", () => ({ resolveNativePortalWorkspaceReadContext: mocks.nativeContext }));
import { resolveDirectViewerWorkspaceContext } from "../src/worker/client-portal/direct-viewer-workspace-context";

const principal = { issuer: "https://access.example.test", subject: "member-one", email: "member@example.test" };
const home = { authorityId: "10000000-0000-4000-8000-000000000001", workspaceId: "workspace-one",
  targetId: "20000000-0000-4000-8000-000000000001", recipientBindingId: "30000000-0000-4000-8000-000000000001",
  ownershipEpoch: 1, grantRevision: 3, expiresAt: null };
const instances: Miniflare[] = [];

async function fixture() {
  const mf = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DELIVERY_DB: "direct-viewer-context" } });
  instances.push(mf);
  const database = await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
  const statements = [
    `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,
      display_name TEXT,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT)`,
    `CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT,source_workspace_id TEXT)`,
    `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT,active_generation_id TEXT,source_sequence INTEGER)`,
    `CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,status TEXT,complete INTEGER)`,
    `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
    `CREATE TABLE portal_client_authority_workspace_claims(client_authority_id TEXT,workspace_id TEXT,projection_source_id TEXT,
      source_workspace_id TEXT,state TEXT,ownership_epoch INTEGER,reconciliation_source_generation TEXT,
      reconciliation_source_sequence INTEGER,reconciliation_snapshot_generation_id TEXT)`,
    `CREATE TABLE portal_v2_root_access_policies(projection_source_id TEXT,root_type TEXT,root_public_id TEXT,state TEXT)`,
    `INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary',NULL,'active','Client One','standalone_client',NULL,'client-one')`,
    `INSERT INTO pa_portal_workspace_sources VALUES('workspace-one','project-alpha:primary','source-workspace-one')`,
    `INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one',7)`,
    `INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1)`,
    `INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','standalone_client','client-one','root-v7',1,'Client One')`,
    `INSERT INTO portal_client_authority_workspace_claims VALUES('10000000-0000-4000-8000-000000000001','workspace-one',
      'project-alpha:primary','source-workspace-one','active',1,'generation-seven',7,'snapshot-seven')`,
  ];
  for (const statement of statements) await database.prepare(statement).run();
  // Miniflare's cross-worker D1 session proxy omits inspect(); keep the
  // production first-primary behavior while returning the local D1 object.
  const deliveryDb = { withSession: () => database, prepare: (...args: Parameters<D1Database["prepare"]>) => database.prepare(...args) };
  const env = { DELIVERY_DB: deliveryDb, CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true",
    CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "false" } as unknown as Env;
  return { database, env };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sourceProof.mockResolvedValue({ sourceId: "project-alpha:primary", version: 4 });
  mocks.homes.mockResolvedValue([home]);
  mocks.nativeContext.mockResolvedValue(null);
});
afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.dispose())); });

describe("direct Viewer Operations-native workspace context", () => {
  it("uses the current Operations home recipient and claim for a claimed workspace", async () => {
    const { env } = await fixture();
    const context = await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one");
    expect(context).toMatchObject({ mode: "operations_native", sourceId: "project-alpha:primary",
      workspaceId: "workspace-one", displayName: "Client One", rootPublicId: "client-one" });
    expect(context?.identityId).toMatch(/^op_[a-f0-9]{64}$/);
    expect(context?.contextVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.homes).toHaveBeenCalledTimes(1);
    expect(mocks.homes.mock.calls[0]?.[0]).toBe(env.DELIVERY_DB);
    expect(mocks.homes.mock.calls[0]?.[1]).toEqual({ issuer: principal.issuer, subject: principal.subject });
    expect(mocks.homes.mock.calls[0]?.[2]).toBe(true);
  });

  it("fails closed without current home membership or when the authority id is wrong", async () => {
    const { env } = await fixture();
    mocks.homes.mockResolvedValueOnce([]);
    expect(await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one")).toBeNull();
    mocks.homes.mockResolvedValueOnce([{ ...home, authorityId: "40000000-0000-4000-8000-000000000001" }]);
    expect(await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one")).toBeNull();
    mocks.homes.mockResolvedValueOnce(null);
    expect(await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one")).toBeNull();
  });

  it("includes current Operations ownership and membership revisions in the fresh context", async () => {
    const { env } = await fixture();
    const first = await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one");
    mocks.homes.mockResolvedValueOnce([{ ...home, ownershipEpoch: 2, grantRevision: 4 }]);
    const next = await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one");
    expect(first?.mode).toBe("operations_native");
    expect(next?.mode).toBe("operations_native");
    expect(next?.contextVersion).not.toBe(first?.contextVersion);
    expect(next?.authorityOwnershipEpoch).toBe(2);
  });

  it("rejects a changed source mapping, legacy-account workspace, or revoked root", async () => {
    const { env, database } = await fixture();
    await database.prepare(`UPDATE pa_portal_workspace_sources SET source_workspace_id='other-source' WHERE workspace_id='workspace-one'`).run();
    expect(await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one")).toBeNull();
    await database.prepare(`UPDATE pa_portal_workspace_sources SET source_workspace_id='source-workspace-one' WHERE workspace_id='workspace-one'`).run();
    await database.prepare(`UPDATE portal_v2_workspaces SET legacy_account_id='legacy-one' WHERE id='workspace-one'`).run();
    expect(await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one")).toBeNull();
    await database.prepare(`UPDATE portal_v2_workspaces SET legacy_account_id=NULL WHERE id='workspace-one'`).run();
    await database.prepare(`INSERT INTO portal_v2_root_access_policies VALUES('project-alpha:primary','standalone_client','client-one','revoked')`).run();
    const policyEnv = { ...env, CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: "true" } as Env;
    expect(await resolveDirectViewerWorkspaceContext(policyEnv, principal, "workspace-one")).toBeNull();
  });

  it("keeps unclaimed workspaces on the existing native PA context and detects membership revision changes", async () => {
    const { env, database } = await fixture();
    await database.prepare(`UPDATE portal_client_authority_workspace_claims SET state='released' WHERE workspace_id='workspace-one'`).run();
    const native = { sourceId: "project-alpha:primary", workspaceId: "workspace-one", identityId: "native-identity",
      contextVersion: "a".repeat(64), displayName: "Client One", rootType: "standalone_client" as const,
      rootPublicId: "client-one" };
    mocks.nativeContext.mockResolvedValue(native);
    const first = await resolveDirectViewerWorkspaceContext(env, principal, "workspace-one");
    expect(first).toMatchObject({ mode: "native", identityId: "native-identity", contextVersion: "a".repeat(64) });
    expect(mocks.homes).not.toHaveBeenCalled();
    expect(mocks.nativeContext).toHaveBeenCalledWith(env, principal, "workspace-one");
  });
});
