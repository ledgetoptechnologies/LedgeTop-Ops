import { afterAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readNativeDirectoryDurableRemoteHead } from "../src/worker/native-directory-profile-writer";
type Database = Parameters<typeof readNativeDirectoryDurableRemoteHead>[0];

const identity = { sourceId: "project-alpha:primary", sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
  applicationUUID: "22222222-2222-4222-8222-222222222222", historyEpoch: "33333333-3333-4333-8333-333333333333",
  origin: "https://pa.example.test" };
const recordId = "ops:acquired:client-17", externalId = "pa:clients:client-92", publicId = "a".repeat(32);
const runtimes: Miniflare[] = [];
afterAll(async () => { for (const runtime of runtimes) await runtime.dispose(); });

function database(rows: Array<Record<string, unknown>>, activation: boolean,
  legacy: { profile?: Array<Record<string, unknown>>; relationship?: Array<Record<string, unknown>> } = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async all<T>() {
        queries.push({ sql, values });
        if (sql.includes("FROM project_alpha_active_directory_mappings")) return { results: rows as T[] };
        if (sql.includes("FROM project_alpha_directory_mappings mapping")) return { results: (legacy.profile ?? []) as T[] };
        if (sql.includes("project_alpha_directory_validated_recovery_relationship_acknowledgements")
          || sql.includes("FROM project_alpha_directory_relationship_outbox outbox"))
          return { results: (legacy.relationship ?? []) as T[] };
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

  it("selects the maximum exact legacy head for clients and the ordinary profile head for organizations", async () => {
    const legacyMapping = { ...mapping, mappingKind: "legacy", externalId: recordId };
    const { db: client } = database([legacyMapping], false, { profile: [
      { projectAlphaPublicId: publicId, revision: "7", authorizationGeneration: "41" }], relationship: [
      { projectAlphaPublicId: publicId, revision: "8", authorizationGeneration: "42" }] });
    await expect(readNativeDirectoryDurableRemoteHead(client, "client", recordId, 2,
      { ...identity, externalCanonicalId: recordId })).resolves.toEqual({ externalCanonicalId: recordId,
        projectAlphaPublicId: publicId, revision: "8" });
    const { db: organization } = database([legacyMapping], false, { profile: [
      { projectAlphaPublicId: publicId, revision: "12", authorizationGeneration: "44" }] });
    await expect(readNativeDirectoryDurableRemoteHead(organization, "organization", recordId, 1,
      { ...identity, externalCanonicalId: recordId })).resolves.toEqual({ externalCanonicalId: recordId,
        projectAlphaPublicId: publicId, revision: "12" });
  });

  it("accepts a same-revision no-op ACK generation advance but rejects identity disagreement or malformed evidence", async () => {
    const legacyMapping = { ...mapping, mappingKind: "legacy", externalId: recordId };
    const noOp = { profile: [{ projectAlphaPublicId: publicId, revision: "8", authorizationGeneration: "41" }],
      relationship: [{ projectAlphaPublicId: publicId, revision: "8", authorizationGeneration: "42" }] };
    const { db: noOpDb } = database([legacyMapping], false, noOp);
    await expect(readNativeDirectoryDurableRemoteHead(noOpDb, "client", recordId, 2,
      { ...identity, externalCanonicalId: recordId })).resolves.toEqual({ externalCanonicalId: recordId,
        projectAlphaPublicId: publicId, revision: "8" });
    for (const evidence of [
      { profile: [{ projectAlphaPublicId: publicId, revision: "8", authorizationGeneration: "41" }],
        relationship: [{ projectAlphaPublicId: "b".repeat(32), revision: "8", authorizationGeneration: "42" }] },
      { profile: [{ projectAlphaPublicId: publicId, revision: "8", authorizationGeneration: "41" }],
        relationship: [{ projectAlphaPublicId: publicId, revision: "not-canonical", authorizationGeneration: "42" }] },
    ]) {
      const { db } = database([legacyMapping], false, evidence);
      await expect(readNativeDirectoryDurableRemoteHead(db, "client", recordId, 2,
        { ...identity, externalCanonicalId: recordId })).resolves.toBeNull();
    }
    const { db: bounded, queries } = database([legacyMapping], false, { profile: [
      { projectAlphaPublicId: publicId, revision: "9", authorizationGeneration: "43" }] });
    await readNativeDirectoryDurableRemoteHead(bounded, "organization", recordId, 1,
      { ...identity, externalCanonicalId: recordId });
    const headQuery = queries.find(query => query.sql.includes("FROM project_alpha_directory_mappings mapping"));
    expect(headQuery?.sql).toContain("invalidEvidence");
    expect(headQuery?.sql).toContain("GROUP BY projectAlphaPublicId,revision,authorizationGeneration");
    expect(headQuery?.sql).toContain("LIMIT 3");
  });

  it("derives one bounded maximum from more than 100 valid durable D1 profile ACKs", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    runtimes.push(runtime); const d1 = await runtime.getD1Database("OPS_DB") as D1Database;
    await d1.batch([d1.prepare(`CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,source_instance_id TEXT,
      application_id TEXT,history_epoch_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,
      project_alpha_public_id TEXT,mapping_kind TEXT,provenance_id TEXT)`),
      d1.prepare(`CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,
      history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT)`),
      d1.prepare(`CREATE TABLE project_alpha_directory_outbox(command_id TEXT,source_id TEXT,expected_source_instance_id TEXT,
      application_id TEXT,expected_history_epoch_id TEXT,resource_type TEXT,external_id TEXT,state TEXT,
      outcome_json TEXT,created_at TEXT)`)]);
    await d1.batch([
      d1.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES(?,?,?,?,?,?,?,?, 'legacy','mapping')")
        .bind(identity.sourceId,identity.sourceInstanceUUID,identity.applicationUUID,identity.historyEpoch,"organization",recordId,recordId,publicId),
      d1.prepare("INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?,?)")
        .bind(identity.sourceId,identity.sourceInstanceUUID,identity.applicationUUID,identity.historyEpoch,"organization",recordId,publicId),
      ...Array.from({ length: 101 }, (_, index) => d1.prepare("INSERT INTO project_alpha_directory_outbox VALUES(?,?,?,?,?,?,?,'acknowledged',?,?)")
        .bind(`command-${index}`,identity.sourceId,identity.sourceInstanceUUID,identity.applicationUUID,identity.historyEpoch,
          "organization",recordId,JSON.stringify({response:{result:{resource:{revision:String(index+1)},authorizationGeneration:"0"}}}),
          `2026-01-01T00:00:${String(index%60).padStart(2,"0")}.000Z`)),
    ]);
    await expect(readNativeDirectoryDurableRemoteHead(d1 as Database,"organization",recordId,1,
      {...identity,externalCanonicalId:recordId})).resolves.toEqual({externalCanonicalId:recordId,
        projectAlphaPublicId:publicId,revision:"101"});
  });
});
