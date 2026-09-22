import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connection: vi.fn() }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({ resolveProjectAlphaApiV2Connection: mocks.connection }));
import { nativeDirectoryProfileEditorRecord } from "../src/worker/native-directory-profile-editor-record";
import type { Env } from "../src/worker/types";

const identity = { sourceId: "project-alpha:primary", sourceInstanceId: "source-instance", applicationId: "application", historyEpochId: "history" };
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
      expectedApplicationId: identity.applicationId, expectedHistoryEpoch: identity.historyEpochId } });
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
});
