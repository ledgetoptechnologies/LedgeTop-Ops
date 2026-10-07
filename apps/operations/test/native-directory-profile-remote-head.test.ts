import { describe, expect, it } from "vitest";
import { readNativeDirectoryDurableRemoteHead } from "../src/worker/native-directory-profile-writer";
type Database = Parameters<typeof readNativeDirectoryDurableRemoteHead>[0];

const identity = { sourceId: "project-alpha:primary", sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
  applicationUUID: "22222222-2222-4222-8222-222222222222", historyEpoch: "33333333-3333-4333-8333-333333333333",
  origin: "https://pa.example.test" };
const recordId = "ops:acquired:client-17", externalId = "pa:clients:client-92", publicId = "a".repeat(32);

function database(rows: Array<Record<string, unknown>>, activation: boolean) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async all<T>() {
        queries.push({ sql, values });
        if (sql.includes("FROM project_alpha_active_directory_mappings")) return { results: rows as T[] };
        return { results: [] as T[] };
      },
      async first<T>() {
        queries.push({ sql, values });
        if (sql.includes("state<>'acknowledged' LIMIT 1")) return null;
        if (sql.includes("FROM operations_directory_intents intent")) return null;
        if (sql.includes("FROM project_alpha_existing_directory_binding_revision_refresh_receipts")) return null;
        if (sql.includes("FROM project_alpha_existing_directory_binding_activation_receipts"))
          return activation && values[1] === recordId && values[7] === externalId && values[8] === publicId
            ? { revision: "4" } as T : null;
        return null;
      },
    };
    return statement;
  }, async batch() { return []; } };
  return { db: db as unknown as Database, queries };
}

describe("native Directory durable remote head for acquired mappings", () => {
  const mapping = { externalId, projectAlphaPublicId: publicId, mappingKind: "acquired", provenanceId: "activation-1" };

  it("resolves the Ops enrollment ID to the exact acquired PA external ID", async () => {
    const { db, queries } = database([mapping], true);
    const result = await readNativeDirectoryDurableRemoteHead(db, "client", recordId, 1,
      { ...identity, externalCanonicalId: recordId });
    expect(result).toEqual({ externalCanonicalId: externalId, projectAlphaPublicId: publicId, revision: "4" });
    const lookup = queries.find(query => query.sql.includes("FROM project_alpha_active_directory_mappings"));
    expect(lookup?.sql).toContain("AND resource_type=? AND record_id=?");
    expect(lookup?.sql).not.toContain("AND external_id=?");
    expect(lookup?.values).toEqual([identity.sourceId, identity.sourceInstanceUUID, identity.applicationUUID,
      identity.historyEpoch, "client", recordId]);
  });

  it("rejects a swapped Ops/external identity and ambiguous active mappings", async () => {
    const { db: mismatched } = database([mapping], true);
    await expect(readNativeDirectoryDurableRemoteHead(mismatched, "client", recordId, 1,
      { ...identity, externalCanonicalId: "ops:some-other-record" })).resolves.toBeNull();
    const { db: duplicate } = database([mapping, mapping], true);
    await expect(readNativeDirectoryDurableRemoteHead(duplicate, "client", recordId, 1,
      { ...identity, externalCanonicalId: recordId })).resolves.toBeNull();
  });

  it("keeps legacy mappings pinned to their exact external ID", async () => {
    const legacy = { ...mapping, mappingKind: "legacy", externalId: recordId };
    const { db } = database([legacy], true);
    await expect(readNativeDirectoryDurableRemoteHead(db, "client", recordId, 1,
      { ...identity, externalCanonicalId: externalId })).resolves.toBeNull();
  });
});
