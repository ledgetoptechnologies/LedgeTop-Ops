import { beforeEach, describe, expect, it, vi } from "vitest";
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
      const statement = { bind: (...values: unknown[]) => { bound.push(values); return statement; }, all: async () => ({ results: rows }) };
      return statement;
    } };
    const organizationRoot = { ...root, public_id: "organization-public-id" };
    await expect(nativeDirectoryLinkedClientEditorRecords({ OPS_DB: database } as unknown as Env, organizationRoot))
      .resolves.toEqual([{ recordId: "acquired:client:one", name: "Linked One" }]);
    expect(bound).toEqual([[identity.sourceId, identity.sourceInstanceId, identity.applicationId,
      identity.historyEpochId, organizationRoot.public_id]]);
    await expect(nativeDirectoryLinkedClientEditorRecords({ OPS_DB: database } as unknown as Env,
      { ...organizationRoot, kind: "standalone_client" })).resolves.toEqual([]);
    await expect(nativeDirectoryLinkedClientEditorRecords({ OPS_DB: database } as unknown as Env,
      { ...organizationRoot, root_namespace: "portal" })).resolves.toEqual([]);
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
