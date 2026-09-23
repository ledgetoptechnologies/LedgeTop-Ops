import { beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
const mocks = vi.hoisted(() => ({ connection: vi.fn() }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({ resolveProjectAlphaApiV2Connection: mocks.connection }));
import { nativeDirectoryLinkedClientEditorRecords, nativeDirectoryOrganizationChoices, nativeDirectoryProfileEditorRecord } from "../src/worker/native-directory-profile-editor-record";
import type { Env } from "../src/worker/types";

const identity = { sourceId: "project-alpha:primary", sourceInstanceId: "11111111-1111-4111-8111-111111111111",
  applicationId: "22222222-2222-4222-8222-222222222222", historyEpochId: "33333333-3333-4333-8333-333333333333" };
function environment(rows: Array<{ recordId: string }>, mapping = identity, bound?: unknown[][]): Env {
  let values: unknown[] = [];
  const statement = { bind: (...next: unknown[]) => { values = next; bound?.push(next); return statement; }, all: async () => ({ results:
    values[0] === mapping.sourceId && values[1] === mapping.sourceInstanceId && values[2] === mapping.applicationId
      && values[3] === mapping.historyEpochId ? rows : [] }) };
  const database = { withSession: () => database, prepare: () => statement };
  return { OPS_DB: database } as unknown as Env;
}

describe("Client Hub native profile editor coordinate", () => {
  const root = { source_id: identity.sourceId, root_namespace: "business", kind: "organization" as const, public_id: "pa-public-id" };
  beforeEach(() => {
    mocks.connection.mockReturnValue({ enabled: true, connection: { expectedSourceInstanceId: identity.sourceInstanceId,
      expectedApplicationId: identity.applicationId, expectedHistoryEpoch: identity.historyEpochId,
      baseUrl: "https://pa.example.test" } });
  });

  it("uses only an exact, unambiguous active mapping rather than the projected public ID", async () => {
    const bound: unknown[][] = [];
    await expect(nativeDirectoryProfileEditorRecord(environment([{ recordId: "ops-org-record" }], identity, bound), root))
      .resolves.toEqual({ recordId: "ops-org-record", kind: "organization" });
    expect(bound).toEqual([[identity.sourceId, identity.sourceInstanceId, identity.applicationId, identity.historyEpochId,
      "organization", root.public_id, "organization"]]);
    await expect(nativeDirectoryProfileEditorRecord(environment([]), root)).resolves.toBeNull();
    await expect(nativeDirectoryProfileEditorRecord(environment([{ recordId: "first" }, { recordId: "second" }]), root)).resolves.toBeNull();
  });

  it("rejects a sole mapping from a stale source-instance, application, or history epoch", async () => {
    for (const stale of [{ ...identity, sourceInstanceId: "old-source" }, { ...identity, applicationId: "old-app" }, { ...identity, historyEpochId: "old-epoch" }])
      await expect(nativeDirectoryProfileEditorRecord(environment([{ recordId: "stale-record" }], stale), root)).resolves.toBeNull();
  });

  it("does not create an editor coordinate for a non-business or non-Project-Alpha root", async () => {
    await expect(nativeDirectoryProfileEditorRecord(environment([{ recordId: "wrong" }]), { ...root, root_namespace: "portal" })).resolves.toBeNull();
    await expect(nativeDirectoryProfileEditorRecord(environment([{ recordId: "wrong" }]), { ...root, source_id: "delivery:local" })).resolves.toBeNull();
  });

  it("lists linked-client editor coordinates only through the exact organization mapping and current relationship", async () => {
    const bound: unknown[][] = [], rows = [{ recordId: "acquired:client:one", name: " Linked One " }];
    const database = { withSession: () => database, prepare: (sql: string) => {
      expect(sql).toContain("operations_directory_client_organizations relationship");
      expect(sql).toContain("client.source_instance_id=parent.source_instance_id");
      expect(sql).toContain("allowed.permission='directory.profile.view'");
      expect(sql).toContain("denied.permission='directory.profile.view'");
      const statement = { bind: (...values: unknown[]) => { bound.push(values); return statement; }, all: async () => ({ results: rows }) };
      return statement;
    } };
    const organizationRoot = { ...root, public_id: "organization-public-id" };
    await expect(nativeDirectoryLinkedClientEditorRecords({ OPS_DB: database } as unknown as Env, organizationRoot, "staff-one"))
      .resolves.toEqual([{ recordId: "acquired:client:one", name: "Linked One" }]);
    expect(bound).toEqual([[identity.sourceId, identity.sourceInstanceId, identity.applicationId,
      identity.historyEpochId, organizationRoot.public_id, "staff-one", "staff-one"]]);
    await expect(nativeDirectoryLinkedClientEditorRecords({ OPS_DB: database } as unknown as Env,
      { ...organizationRoot, kind: "standalone_client" }, "staff-one")).resolves.toEqual([]);
    await expect(nativeDirectoryLinkedClientEditorRecords({ OPS_DB: database } as unknown as Env,
      { ...organizationRoot, root_namespace: "portal" }, "staff-one")).resolves.toEqual([]);
  });

  it("does not reveal a linked client's name without an effective child view grant", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    try {
      const db = await runtime.getD1Database("OPS_DB");
      for (const sql of [
        "CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT)",
        "CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT)",
        "CREATE TABLE operations_directory_records(record_id TEXT,record_kind TEXT,current_version INTEGER)",
        "CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,profile_json TEXT)",
        "CREATE TABLE native_directory_grants(staff_id TEXT,permission TEXT,effect TEXT,active INTEGER,scope_kind TEXT,resource_id TEXT,business_area_id TEXT,division_id TEXT)",
        "CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER)",
        "CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT)",
      ]) await db.prepare(sql).run();
      for (const [type, externalId, publicId] of [["organization", "ops-org", root.public_id],
        ["client", "ops-client", "client-public-id"]]) await db.prepare(`INSERT INTO project_alpha_active_directory_mappings
        (source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
        VALUES(?,?,?,?,?,?,?)`).bind(identity.sourceId, identity.sourceInstanceId, identity.applicationId,
          identity.historyEpochId, type, externalId, publicId).run();
      await db.prepare("INSERT INTO operations_directory_client_organizations VALUES('ops-client','ops-org')").run();
      await db.prepare("INSERT INTO operations_directory_records VALUES('ops-client','client',1)").run();
      await db.prepare("INSERT INTO operations_directory_revisions VALUES('ops-client',1,'{\"name\":\"Private Child\"}')").run();
      const env = { OPS_DB: db } as unknown as Env;
      await expect(nativeDirectoryLinkedClientEditorRecords(env, root, "staff-one")).resolves.toEqual([]);
      await db.prepare("INSERT INTO native_directory_grants(staff_id,permission,effect,active,scope_kind,resource_id) VALUES('staff-one','directory.profile.view','allow',1,'resource','ops-client')").run();
      await expect(nativeDirectoryLinkedClientEditorRecords(env, root, "staff-one"))
        .resolves.toEqual([{ recordId: "ops-client", name: "Private Child" }]);
      await db.prepare("INSERT INTO native_directory_grants(staff_id,permission,effect,active,scope_kind,resource_id) VALUES('staff-one','directory.profile.view','deny',1,'resource','ops-client')").run();
      await expect(nativeDirectoryLinkedClientEditorRecords(env, root, "staff-one")).resolves.toEqual([]);
    } finally { await runtime.dispose(); }
  });

  it("offers a non-UUID acquired organization only with exact configured enrollment and active mapping", async () => {
    const recordId = "acquired:organization:west", destination = { sourceId: identity.sourceId,
      sourceInstanceUUID: identity.sourceInstanceId, applicationUUID: identity.applicationId,
      historyEpoch: identity.historyEpochId, origin: "https://pa.example.test", externalCanonicalId: recordId };
    const make = (mapped: boolean) => {
      const database = { withSession: () => database, prepare: (sql: string) => {
        const statement = { bind: () => statement, all: async () => ({ results: sql.includes("operations_directory_records") ? [{
          recordId, expectedVersion: 7, profileJson: JSON.stringify({ name: "Acquired West" }),
          destinationsJson: JSON.stringify([destination]),
        }] : [] }), first: async () => mapped ? { present: 1 } : null };
        return statement;
      } };
      return { OPS_DB: database } as unknown as Env;
    };
    await expect(nativeDirectoryOrganizationChoices(make(true))).resolves.toEqual([{
      recordId, expectedVersion: 7, name: "Acquired West", sourceIds: [identity.sourceId],
    }]);
    await expect(nativeDirectoryOrganizationChoices(make(false))).resolves.toEqual([]);
    mocks.connection.mockReturnValueOnce({ enabled: true, connection: { expectedSourceInstanceId: "wrong",
      expectedApplicationId: identity.applicationId, expectedHistoryEpoch: identity.historyEpochId,
      baseUrl: "https://pa.example.test" } });
    await expect(nativeDirectoryOrganizationChoices(make(true))).resolves.toEqual([]);
  });
});
