import { findClientHubRoot } from "../src/worker/client-hub-directory";
import type { Env } from "../src/worker/types";
import { captureImportQueries, checkImportQueryDepth } from "./helpers/native-import-query-depth";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareNativeExistingDirectoryImport, executeNativeExistingDirectoryImport, readNativeExistingDirectoryImportStatus, renewNativeExistingDirectoryImport } from "../src/worker/native-directory-existing-import";
import { writeNativeExistingDirectoryImport } from "../src/worker/native-directory-existing-import-writer";
import { resolveClientHubSourceRoot, resolveClientHubSourceRootByAlphaPublicId } from "../src/worker/client-hub-source";
import { nativeExistingImportRecordId } from "../src/worker/native-directory-existing-import-identity";
import { selectGrant } from "../src/worker/native-directory-profile-routes";
import type { NativeExistingImportActor, NativeExistingImportReview } from "../src/worker/native-directory-existing-import-types";
import { fullImportDatabase, importCase, noRemoteCreateRows, opaquePublicId, paImportTransport, preservationRows, sha, uuid, type ImportFixture } from "./helpers/native-existing-import-fixture";

let databases: Awaited<ReturnType<typeof fullImportDatabase>>;
let actorDenialFixture: ImportFixture | undefined;
beforeAll(async () => { databases = await fullImportDatabase(); }, 240_000);
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => { await databases.runtime.dispose(); });

async function reviewed(f: ImportFixture): Promise<NativeExistingImportReview> {
  const result = await prepareNativeExistingDirectoryImport(f.env, f.selection, f.actor);
  expect(result.status, JSON.stringify(result)).toBe("reviewed");
  if (result.status !== "reviewed") throw new Error(`Import review failed: ${JSON.stringify(result)}`);
  f.nativeRecordId = result.review.nativeRecordId;
  return result.review;
}
async function absentNative(f: ImportFixture) {
  const recordId = f.nativeRecordId ?? f.selection.recordId;
  expect(await databases.db.prepare("SELECT count(*) n FROM operations_directory_records").first("n")).toBe(f.initialNativeCount);
  expect(await databases.db.prepare("SELECT record_id FROM operations_directory_records WHERE record_id=?").bind(recordId).first()).toBeNull();
  expect(await noRemoteCreateRows(databases.db)).toEqual({ project_alpha_directory_outbox: 0, operations_directory_intents: 0, operations_directory_materializations: 0 });
}
const install = (...fixtures: ImportFixture[]) => { const transport = paImportTransport(fixtures); vi.stubGlobal("fetch", transport.fetcher); return transport; };

describe("reviewed existing PA Directory import with full native D1 guards", { timeout: 60_000 }, () => {
  it("reviews existing source-qualified IDs without materializing native rows or remote create work", async () => {
    const f = await importCase(databases.db); const transport = install(f);
    const before = await preservationRows(databases.db), review = await reviewed(f);
    expect(review).toMatchObject({ recordId: f.selection.recordId, publicId: f.publicId, sourceId: f.selection.sourceId,
      sourceInstanceId: f.identity.sourceInstanceId, applicationId: f.identity.applicationId, historyEpoch: f.identity.historyEpoch,
      businessAreaId: "business-area-ltds", classicPayload: f.classicPayload, batchId: f.selection.batchId });
    expect(review.profile).toMatchObject({generalEmail:f.profile.email,generalPhone:f.profile.phone});
    await absentNative(f);
    expect(transport.posts()).toHaveLength(0);
    expect(await preservationRows(databases.db)).toEqual(before);
  });

  it("rejects malformed execution clocks atomically while a valid reviewed actor remains admitted", async () => {
    const f = await importCase(databases.db); install(f); const review = await reviewed(f);
    const at = new Date().toISOString(), deadline = new Date(Date.now()+60_000).toISOString();
    for (const [created, verified, assertion] of [["!",deadline,deadline],[at,"!",deadline],[at,deadline,"!"],[at,deadline,"2099-01-01"]]) {
      const executionId = crypto.randomUUID();
      await expect(databases.db.batch([
        databases.db.prepare("INSERT INTO native_directory_existing_import_execution_admissions(execution_id,import_id,actor_json,created_at,verified_until) VALUES(?,?,?,?,?)")
          .bind(executionId, review.importId, JSON.stringify({...f.actor,verifiedUntil:assertion}),created,verified),
        databases.db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,'Must roll back',1)").bind(`malformed-${executionId}`),
      ])).rejects.toThrow();
      expect(await databases.db.prepare("SELECT execution_id FROM native_directory_existing_import_execution_admissions WHERE execution_id=?").bind(executionId).first()).toBeNull();
      expect(await databases.db.prepare("SELECT id FROM native_business_areas WHERE id=?").bind(`malformed-${executionId}`).first()).toBeNull();
    }
    const validExecution = crypto.randomUUID();
    await databases.db.prepare("INSERT INTO native_directory_existing_import_execution_admissions(execution_id,import_id,actor_json,created_at,verified_until) VALUES(?,?,?,?,?)")
      .bind(validExecution,review.importId,JSON.stringify(f.actor),new Date().toISOString(),deadline).run();
    expect(await databases.db.prepare("SELECT execution_id FROM native_directory_existing_import_execution_admissions WHERE execution_id=?").bind(validExecution).first("execution_id")).toBe(validExecution);
    await absentNative(f);
  });

  it("derives its execution deadline from the exact admission creation timestamp when a later clock read advances", async () => {
    const f=await importCase(databases.db);install(f);const review=await reviewed(f);
    // Simulate the second clock sample advancing. The admission's new Date()
    // remains real, so the unchanged SQL maximum-lifetime guard catches drift.
    const laterClock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+60_000);
    try {
      const outcome=await writeNativeExistingDirectoryImport(f.env,review,f.actor);
      expect(outcome,JSON.stringify(outcome)).toMatchObject({status:"imported"});
      const admission=await databases.db.prepare('SELECT created_at,verified_until FROM native_directory_existing_import_execution_admissions WHERE import_id=?')
        .bind(review.importId).first<{created_at:string;verified_until:string}>();
      expect(admission).not.toBeNull();
      expect(Date.parse(admission!.verified_until)-Date.parse(admission!.created_at)).toBe(15*60_000);
    } finally { laterClock.mockRestore(); }
  });

  it("renews only the original current admitted actor and rejects forged completion receipts", async () => {
    const f = await importCase(databases.db); install(f); const review = await reviewed(f);
    expect(await renewNativeExistingDirectoryImport(f.env,review.importId,f.actor)).toMatchObject({status:"reviewed",review:{importId:review.importId,nativeRecordId:review.nativeRecordId}});
    for (const field of ["staffId","accessSubject","loginEmail","admissionVersion","profileVersion","grantGeneration"]) {
      const forged = {...f.actor,[field]:typeof f.actor[field as keyof NativeExistingImportActor] === "number" ? 999 : "foreign-actor"};
      const at = new Date().toISOString(), expiry = new Date(Date.now()+60_000).toISOString();
      await expect(databases.db.prepare("INSERT INTO native_directory_existing_import_renewals(renewal_id,import_id,actor_json,created_at,expires_at) VALUES(?,?,?,?,?)")
        .bind(crypto.randomUUID(),review.importId,JSON.stringify(forged),at,expiry).run()).rejects.toThrow();
    }
    for (const [state,detail] of [["local_imported",{recordId:review.nativeRecordId,classicRecordId:review.recordId}],
      ["acquired",{commandId:uuid(930_001),expectedGeneration:"5",nextGeneration:"6"}],
      ["activated",{activationId:uuid(930_002)}]]) {
      await expect(databases.db.prepare("INSERT INTO native_directory_existing_import_events(import_id,state,detail_json) VALUES(?,?,?)")
        .bind(review.importId,state,JSON.stringify(detail)).run()).rejects.toThrow();
    }
    expect(await databases.db.prepare("SELECT count(*) n FROM native_directory_existing_import_renewals WHERE import_id=?").bind(review.importId).first("n")).toBe(1);
    expect(await databases.db.prepare("SELECT count(*) n FROM native_directory_existing_import_events WHERE import_id=?").bind(review.importId).first("n")).toBe(0);
    await absentNative(f);
  });

  it("preserves live business-party grouping, allows unlinked history, and rechecks a link introduced after review", async () => {
    const f = await importCase(databases.db); const transport = install(f);
    const link = async (suffix:string) => {
      const partyId=`import-party-${f.n}-${suffix}`, linkId=`import-party-link-${f.n}-${suffix}`;
      await databases.db.batch([
        databases.db.prepare(`INSERT INTO business_parties(id,kind,display_name,sort_name,created_by,updated_by,lifecycle_origin)
          VALUES(?,'organization','Existing grouped customer','existing grouped customer',?,?,'operations')`).bind(partyId,f.actor.staffId,f.actor.staffId),
        databases.db.prepare(`INSERT INTO business_party_links(id,party_id,source_id,record_kind,record_id,linked_by)
          VALUES(?,?,?,'organization',?,?)`).bind(linkId,partyId,f.selection.sourceId,f.selection.recordId,f.actor.staffId),
      ]);
      return linkId;
    };
    const firstLink=await link("initial");
    expect(await prepareNativeExistingDirectoryImport(f.env,f.selection,f.actor)).toMatchObject({status:"blocked"});
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
    await databases.db.prepare("UPDATE business_party_links SET unlinked_by=?,unlinked_at=datetime('now') WHERE id=?").bind(f.actor.staffId,firstLink).run();
    const review=await reviewed(f); // Immutable, unlinked history is permitted.
    await link("after-review");
    const before=(await databases.db.prepare("SELECT * FROM business_party_links WHERE source_id=? ORDER BY id").bind(f.selection.sourceId).all()).results;
    expect(await writeNativeExistingDirectoryImport(f.env,review,f.actor)).toMatchObject({status:expect.stringMatching(/blocked|conflict/)});
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
    expect((await databases.db.prepare("SELECT * FROM business_party_links WHERE source_id=? ORDER BY id").bind(f.selection.sourceId).all()).results).toEqual(before);
  });

  it("binds and activates the exact existing PA object, preserving grants, classic data and opaque portal/share identities", async () => {
    const f = await importCase(databases.db, "client"); const transport = install(f);
    const captured = captureImportQueries(f.env.OPS_DB); f.env.OPS_DB = captured.database;
    const workspaceId = "portal-workspace-distinct-from-classic-record", shareId = "previous-client-link";
    await databases.delivery.batch([
      databases.delivery.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,?)").bind(workspaceId, f.selection.sourceId, f.publicId),
      databases.delivery.prepare("INSERT INTO shares VALUES(?,?,?,?)").bind(shareId, workspaceId, "existing-share-token-hash", "existing/r2/prefix"),
    ]);
    const portalBefore = await databases.delivery.batch([databases.delivery.prepare("SELECT * FROM portal_v2_workspaces"), databases.delivery.prepare("SELECT * FROM shares")]);
    const before = await preservationRows(databases.db), review = await reviewed(f);
    const result = await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor);
    expect(result).toMatchObject({ status: "activated", recordId: review.nativeRecordId, replayed: false });
    expect(await databases.db.prepare("SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id=?")
      .bind(review.nativeRecordId).first()).toEqual({ record_id: review.nativeRecordId, record_kind: "client", current_version: 1 });
    expect(await databases.db.prepare("SELECT business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id=?")
      .bind(review.nativeRecordId).first()).toEqual({ business_area_id: "business-area-ltds", division_id: null, active: 1 });
    expect(await databases.db.prepare("SELECT organization_record_id FROM operations_directory_client_organizations WHERE client_record_id=?")
      .bind(review.nativeRecordId).first("organization_record_id")).toBeNull();
    expect(await resolveClientHubSourceRootByAlphaPublicId(f.env, "standalone_client", f.selection.sourceId, f.publicId))
      .toMatchObject({ id: review.nativeRecordId, pa_public_id: f.publicId, mapping_status: "mapped" });
    expect(f.selection.recordId).not.toBe(workspaceId); expect(f.selection.recordId).not.toBe(f.publicId);
    expect(await databases.db.prepare("SELECT payload_json FROM pa_clients WHERE id=?").bind(f.selection.recordId).first("payload_json")).toBe(f.classicPayload);
    expect(await noRemoteCreateRows(databases.db)).toEqual({ project_alpha_directory_outbox: 0, operations_directory_intents: 0, operations_directory_materializations: 0 });
    expect(await preservationRows(databases.db)).toEqual(before);
    expect((await databases.delivery.batch([databases.delivery.prepare("SELECT * FROM portal_v2_workspaces"), databases.delivery.prepare("SELECT * FROM shares")])).map(x => x.results))
      .toEqual(portalBefore.map(x => x.results));
    expect(transport.posts()).toHaveLength(1);
    expect(JSON.parse(String(transport.posts()[0]![1]?.body))).toMatchObject({ externalId: review.nativeRecordId, expectedPublicId: f.publicId });
    for (const key of [review.nativeRecordId, f.selection.recordId])
      expect(await resolveClientHubSourceRoot(f.env,"standalone_client",key,f.selection.sourceId))
        .toMatchObject({id:review.nativeRecordId,pa_internal_id:f.selection.recordId,pa_public_id:f.publicId});
    // Rebuildable index cache is fixture data, never mapping authority. The
    // lookup must still prove the real acquired/activated native chain above.
    await databases.db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,pa_public_id,mapping_status,display_name,sort_name,status)
      VALUES(?,'business','standalone_client',?,?,'mapped','Existing PA customer','existing pa customer','active')`)
      .bind(f.selection.sourceId,review.nativeRecordId,f.publicId).run();
    expect(await findClientHubRoot(f.env as Env,"standalone_client",f.selection.recordId,f.selection.sourceId,"business"))
      .toMatchObject({public_id:review.nativeRecordId,pa_public_id:f.publicId});
    expect(checkImportQueryDepth(captured.queries).count).toBeGreaterThan(30);
  });

  it("replays one immutable review and activated command without a second PA binding", async () => {
    const f = await importCase(databases.db); const transport = install(f), review = await reviewed(f);
    expect(await prepareNativeExistingDirectoryImport(f.env, f.selection, f.actor)).toMatchObject({ status: "reviewed", replayed: true, review: { importId: review.importId } });
    expect(await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor)).toMatchObject({ status: "activated" });
    const events = await databases.db.prepare("SELECT state,detail_json FROM native_directory_existing_import_events WHERE import_id=? ORDER BY event_id").bind(review.importId).all();
    expect(await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor)).toMatchObject({ status: "activated", replayed: true });
    expect((await databases.db.prepare("SELECT state,detail_json FROM native_directory_existing_import_events WHERE import_id=? ORDER BY event_id").bind(review.importId).all()).results).toEqual(events.results);
    expect(transport.posts()).toHaveLength(1);
  });

  it("rejects idempotency retargeting and source-to-business-area substitution", async () => {
    const f = await importCase(databases.db); const transport = install(f); await reviewed(f);
    expect(await prepareNativeExistingDirectoryImport(f.env, { ...f.selection, businessAreaId: "business-area-ltt" }, f.actor))
      .toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    expect(await prepareNativeExistingDirectoryImport(f.env, { ...f.selection, recordId: "some-other-existing-record" }, f.actor))
      .toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it.each([
    ["access subject", { accessSubject: "other-access-subject" }],
    ["login email", { loginEmail: "different@example.test" }],
    ["admission version", { admissionVersion: 99 }],
    ["profile version", { profileVersion: 99 }],
    ["grant generation", { grantGeneration: 99 }],
    ["expired verification", { verifiedUntil: "2020-01-01T00:00:00.000Z" }],
  ] as const)("rejects stale or foreign actor %s before native import", async (_label, changed) => {
    const f = actorDenialFixture ??= await importCase(databases.db);
    const transport = install(f), actor: NativeExistingImportActor = { ...f.actor, ...changed };
    expect(await prepareNativeExistingDirectoryImport(f.env, f.selection, actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it.each(["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"])("honors an applicable %s deny even with current owner/grant generation", async permission => {
    const f = await importCase(databases.db); const transport = install(f);
    await databases.db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by) VALUES(?,?,?,'deny','business_area',?,?)")
      .bind(`deny-${f.n}`, f.actor.staffId, permission, f.selection.businessAreaId, f.actor.staffId).run();
    const generation = await databases.db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(f.actor.staffId).first<number>("generation");
    expect(await prepareNativeExistingDirectoryImport(f.env, f.selection, { ...f.actor, grantGeneration: generation! })).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it("rejects fresh PA history-epoch disagreement and tombstoned bindings", async () => {
    const f = await importCase(databases.db); const transport = install(f), state = transport.states.get(f.origin)!;
    state.wrongEpoch = true;
    expect(await prepareNativeExistingDirectoryImport(f.env, f.selection, f.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    state.wrongEpoch = false; state.tombstoned = true;
    expect(await prepareNativeExistingDirectoryImport(f.env, f.selection, f.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it("rechecks current owner role after review and refuses local materialization", async () => {
    const f = await importCase(databases.db); const transport = install(f), review = await reviewed(f);
    await databases.db.prepare("DELETE FROM staff_role_assignments WHERE staff_id=? AND role_id='role-owner'").bind(f.actor.staffId).run();
    expect(await writeNativeExistingDirectoryImport(f.env, review, f.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it("rolls back every native row when profile-edit authority is revoked between preflight and the guarded batch", async () => {
    const f = await importCase(databases.db); const transport = install(f), review = await reviewed(f);
    let revoked = false;
    const wrap = (database: D1Database): D1Database => new Proxy(database, { get(target, key) {
      if (key === "withSession") return (...args: Parameters<D1Database["withSession"]>) =>
        wrap(target.withSession(...args) as unknown as D1Database);
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!revoked) { revoked = true; await databases.db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?")
          .bind(`${f.actor.staffId}:directory.profile.edit`).run(); }
        return target.batch(statements);
      };
      const value = target[key as keyof D1Database]; return typeof value === "function" ? value.bind(target) : value;
    } });
    const raced = wrap(databases.db);
    expect(await writeNativeExistingDirectoryImport({ ...f.env, OPS_DB: raced }, review, f.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    expect(revoked).toBe(true); await absentNative(f);
    expect(await databases.db.prepare("SELECT import_id FROM native_directory_existing_import_local_receipts WHERE import_id=?").bind(review.importId).first()).toBeNull();
    expect(transport.posts()).toHaveLength(0);
  });

  it("exposes an honest local pending import until the existing PA binding is acknowledged and activated", async () => {
    const f = await importCase(databases.db); install(f); const review = await reviewed(f);
    expect(await writeNativeExistingDirectoryImport(f.env, review, f.actor)).toMatchObject({ status: "imported", recordId: review.nativeRecordId });
    expect(await databases.db.prepare("SELECT record_id FROM project_alpha_active_directory_mappings WHERE record_id=?").bind(review.nativeRecordId).first()).toBeNull();
    const status = await readNativeExistingDirectoryImportStatus(f.env, review.importId, f.actor);
    expect(JSON.stringify(status)).not.toContain('"status":"activated"');
    expect(JSON.stringify(status)).toMatch(/pending|local_imported|reviewed/);
    expect(await noRemoteCreateRows(databases.db)).toEqual({ project_alpha_directory_outbox: 0, operations_directory_intents: 0, operations_directory_materializations: 0 });
  });

  it("keeps identical PA public IDs and email addresses in different sources distinct", async () => {
    const a = await importCase(databases.db), b = await importCase(databases.db, "organization", { publicId: a.publicId, area: "business-area-ltt" });
    const transport = install(a, b), ar = await reviewed(a), br = await reviewed(b);
    const activatedA=await executeNativeExistingDirectoryImport(a.env, { importId: ar.importId }, a.actor);
    expect(activatedA,JSON.stringify(activatedA)).toMatchObject({ status: "activated", recordId: ar.nativeRecordId });
    const activatedB=await executeNativeExistingDirectoryImport(b.env, { importId: br.importId }, b.actor);
    expect(activatedB,JSON.stringify(activatedB)).toMatchObject({ status: "activated", recordId: br.nativeRecordId });
    expect(await resolveClientHubSourceRootByAlphaPublicId(a.env, "organization", a.selection.sourceId, a.publicId)).toMatchObject({ id: ar.nativeRecordId });
    expect(await resolveClientHubSourceRootByAlphaPublicId(b.env, "organization", b.selection.sourceId, b.publicId)).toMatchObject({ id: br.nativeRecordId });
    expect(a.selection.recordId).not.toBe(b.selection.recordId); expect(transport.posts()).toHaveLength(2);
  });

  it("requires the exact same-source parent to activate before importing an organization child", async () => {
    const parent = await importCase(databases.db), child = await importCase(databases.db, "client", {
      sourceId: parent.selection.sourceId, sourceFixture: parent, parentRecordId: parent.selection.recordId, parentPublicId: parent.publicId });
    const transport = install(parent, child), pr = await reviewed(parent), cr = await reviewed(child);
    expect(await writeNativeExistingDirectoryImport(child.env, cr, child.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(child);
    const activatedParent=await executeNativeExistingDirectoryImport(parent.env, { importId: pr.importId }, parent.actor);
    expect(activatedParent,JSON.stringify(activatedParent)).toMatchObject({ status: "activated" });
    // Ordinary inventory refresh after our parent's own ACK advances to G6.
    // The child's reviewed object/revision remains unchanged and must resume.
    const refreshedRequest = uuid(920_001);
    await databases.db.batch([
      databases.db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,
        inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
        VALUES(?,?,?,?,'directory',?,'6',NULL,NULL,?,1)`).bind(child.selection.sourceId,child.identity.sourceInstanceId,child.identity.applicationId,child.identity.historyEpoch,refreshedRequest,"a".repeat(64)),
      databases.db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,
        request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256)
        VALUES(?,?,?,?,?,'client',?,'7',1,'upsert',?)`).bind(child.selection.sourceId,child.identity.sourceInstanceId,child.identity.applicationId,child.identity.historyEpoch,refreshedRequest,child.publicId,sha(JSON.stringify(child.profile))),
    ]);
    expect(cr.observation.authorizationGeneration).toBe("5");
    expect(await executeNativeExistingDirectoryImport(child.env, { importId: cr.importId }, child.actor)).toMatchObject({ status: "activated" });
    expect(await databases.db.prepare("SELECT organization_record_id FROM operations_directory_client_organizations WHERE client_record_id=?").bind(cr.nativeRecordId).first("organization_record_id")).toBe(pr.nativeRecordId);
    expect(transport.posts()).toHaveLength(2);
    expect(transport.posts().map(([, init]) => JSON.parse(String(init?.body)).expectedAuthorizationGeneration)).toEqual(["5", "6"]);
  });

  it("holds unexpected PA generation advances instead of adopting an external write into the reviewed batch", async () => {
    const f = await importCase(databases.db); const transport = install(f), review = await reviewed(f);
    transport.states.get(f.origin)!.generation++;
    const result = await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor);
    expect(result.status).not.toBe("activated"); expect(transport.posts()).toHaveLength(0);
    expect(await databases.db.prepare("SELECT record_id FROM project_alpha_active_directory_mappings WHERE record_id=?").bind(review.nativeRecordId).first()).toBeNull();
  });

  it("reconciles a PA commit with a lost acknowledgement using the same command and original import IDs", async () => {
    const f = await importCase(databases.db); const transport = install(f), review = await reviewed(f);
    transport.states.get(f.origin)!.loseNextAck = true;
    expect(await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor)).toMatchObject({ status: "pending", importId: review.importId });
    expect(await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor)).toMatchObject({ status: "activated", recordId: review.nativeRecordId });
    const commandIds = transport.posts().map(([, init]) => JSON.parse(String(init?.body)).commandId);
    expect(new Set(commandIds).size).toBe(1); expect(commandIds.length).toBeLessThanOrEqual(2);
    expect(await databases.db.prepare("SELECT count(*) n FROM operations_directory_records WHERE record_id=?").bind(review.nativeRecordId).first("n")).toBe(1);
    expect(await noRemoteCreateRows(databases.db)).toEqual({ project_alpha_directory_outbox: 0, operations_directory_intents: 0, operations_directory_materializations: 0 });
  });

  it("rejects forged review/execution SQL independently of the request validators", async () => {
    const f = await importCase(databases.db); install(f); const review = await reviewed(f);
    const forged = { ...review, importId: uuid(900_001), idempotencyKey: uuid(900_002), historyEpoch: uuid(900_003), publicId: opaquePublicId(900_004) };
    await expect(databases.db.prepare(`INSERT INTO native_directory_existing_import_reviews(import_id,idempotency_key,request_sha256,review_json,created_at,expires_at)
      VALUES(?,?,?, ?,?,?)`).bind(forged.importId, forged.idempotencyKey, "f".repeat(64), JSON.stringify(forged), forged.reviewedAt, forged.expiresAt).run()).rejects.toThrow();
    await expect(databases.db.prepare(`INSERT INTO native_directory_existing_import_execution_admissions(execution_id,import_id,actor_json,created_at,verified_until)
      VALUES(?,?,?,?,?)`).bind(uuid(900_005), review.importId, JSON.stringify({ ...f.actor, accessSubject: "forged-subject" }), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()).run()).rejects.toThrow();
    await absentNative(f);
  });

  it("derives native identities from source, kind and classic ID, rejecting identities that exceed the native contract", () => {
    const classicId = "1";
    const values = ["project-alpha:primary", "project-alpha:secondary"].flatMap(source =>
      (["organization", "client"] as const).map(kind => nativeExistingImportRecordId(source, kind, classicId)));
    expect(new Set(values).size).toBe(4);
    expect(values).toContain("pa-import:project-alpha:primary:organization:1");
    expect(nativeExistingImportRecordId("project-alpha:primary", "organization", classicId)).toBe(values[0]);
    expect(() => nativeExistingImportRecordId("project-alpha:primary", "organization", "x".repeat(191))).toThrow();
    expect(() => nativeExistingImportRecordId("project-alpha:primary", "organization", "bad\u0000id")).toThrow();
  });

  it("imports colliding classic organization/client IDs separately and resolves their original URLs with current native deny checks", async () => {
    const organization = await importCase(databases.db, "organization", { classicId: "collision-1" });
    const client = await importCase(databases.db, "client", { classicId: "collision-1", sourceId: organization.selection.sourceId, sourceFixture: organization });
    const otherOrganization = await importCase(databases.db, "organization", { classicId: "collision-2", area: "business-area-ltt" });
    const otherClient = await importCase(databases.db, "client", { classicId: "collision-2", area: "business-area-ltt", sourceId: otherOrganization.selection.sourceId, sourceFixture: otherOrganization });
    const transport = install(organization, client, otherOrganization, otherClient);
    const pairs: Array<{ f: ImportFixture; review: NativeExistingImportReview }> = [];
    for (const f of [organization, client, otherOrganization, otherClient]) pairs.push({ f, review: await reviewed(f) });
    expect(new Set(pairs.map(({ review }) => review.nativeRecordId)).size).toBe(4);
    for (const { f, review } of pairs) {
      expect(review.nativeRecordId).toBe(`pa-import:${f.selection.sourceId}:${f.selection.kind}:${f.selection.recordId}`);
      expect(await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor)).toMatchObject({ status: "activated", recordId: review.nativeRecordId });
      const kind = f.selection.kind === "client" ? "standalone_client" : "organization";
      expect(await resolveClientHubSourceRoot(f.env, kind, f.selection.recordId, f.selection.sourceId)).toMatchObject({ id: review.nativeRecordId, pa_public_id: f.publicId });
      expect(await resolveClientHubSourceRootByAlphaPublicId(f.env, kind, f.selection.sourceId, f.publicId)).toMatchObject({ id: review.nativeRecordId });
    }
    const target = pairs[1]!, kind = "standalone_client";
    expect(await resolveClientHubSourceRoot(target.f.env, kind, target.f.selection.recordId, otherClient.selection.sourceId)).toBeNull();
    await databases.db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?,?,'directory.profile.view','deny','resource',?,?)")
      .bind("deny-canonical-import-alias", target.f.actor.staffId, target.review.nativeRecordId, target.f.actor.staffId).run();
    const translated = await resolveClientHubSourceRoot(target.f.env, kind, target.f.selection.recordId, target.f.selection.sourceId);
    expect(translated).toMatchObject({ id: target.review.nativeRecordId });
    expect(await selectGrant(databases.db, target.f.actor.staffId, "directory.profile.view", translated!.id, [], false)).toBeNull();
    expect(transport.posts()).toHaveLength(4);
    expect(await noRemoteCreateRows(databases.db)).toEqual({ project_alpha_directory_outbox: 0, operations_directory_intents: 0, operations_directory_materializations: 0 });
  });

  it("does not start an import when the feature, source configuration or selected source area is unavailable", async () => {
    const f = await importCase(databases.db); const transport = install(f);
    for (const env of [{ ...f.env, NATIVE_DIRECTORY_EXISTING_IMPORT_ENABLED: "false" },
      { ...f.env, NATIVE_DIRECTORY_EXISTING_IMPORT_AREAS: "{}" },
      { ...f.env, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {} }) }])
      expect(await prepareNativeExistingDirectoryImport(env, f.selection, f.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it("requires a new review when the authoritative PA profile changes before import", async () => {
    const f = await importCase(databases.db); const transport = install(f), review = await reviewed(f);
    transport.states.get(f.origin)!.profileName = "Changed after operator review";
    expect(await executeNativeExistingDirectoryImport(f.env, { importId: review.importId }, f.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it("invalidates an already reviewed import when current inventory records a newer PA revision", async () => {
    const f = await importCase(databases.db); const transport = install(f), review = await reviewed(f), requestId = uuid(910_001);
    await databases.db.batch([
      databases.db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,
        inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
        VALUES(?,?,?,?,'directory',?,'5',NULL,NULL,?,1)`).bind(f.selection.sourceId, f.identity.sourceInstanceId, f.identity.applicationId, f.identity.historyEpoch, requestId, "d".repeat(64)),
      databases.db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,
        request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256)
        VALUES(?,?,?,?,?,?,?,'8',1,'upsert',?)`).bind(f.selection.sourceId, f.identity.sourceInstanceId, f.identity.applicationId, f.identity.historyEpoch, requestId, f.selection.kind, f.publicId, "e".repeat(64)),
    ]);
    expect(await writeNativeExistingDirectoryImport(f.env, review, f.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it("refuses inactive duplicate classic public IDs introduced after review", async () => {
    const f = await importCase(databases.db); const transport = install(f), review = await reviewed(f);
    await databases.db.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization',?,?)")
      .bind(f.selection.sourceId, `inactive-external-${f.n}`, `inactive-duplicate-${f.n}`).run();
    await databases.db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,'Inactive duplicate',0,?,'fixture-duplicate',?)")
      .bind(`inactive-duplicate-${f.n}`, JSON.stringify({ public_id: f.publicId }), f.selection.sourceId).run();
    expect(await writeNativeExistingDirectoryImport(f.env, review, f.actor)).toMatchObject({ status: expect.stringMatching(/blocked|conflict/) });
    await absentNative(f); expect(transport.posts()).toHaveLength(0);
  });

  it("does not advance another source cursor from an unrelated valid acquisition acknowledgement", async () => {
    const a = await importCase(databases.db), b = await importCase(databases.db); install(a, b);
    const ar = await reviewed(a), br = await reviewed(b);
    expect(await executeNativeExistingDirectoryImport(b.env, { importId: br.importId }, b.actor)).toMatchObject({ status: "activated" });
    const command = await databases.db.prepare("SELECT command_id FROM native_directory_existing_import_binding_intents WHERE import_id=?").bind(br.importId).first<string>("command_id");
    expect(command).toBeTypeOf("string");
    const before = (await databases.db.prepare("SELECT * FROM native_directory_existing_import_source_cursors WHERE batch_id=? AND source_id=?")
      .bind(ar.batchId, ar.sourceId).all()).results;
    await expect(databases.db.batch([
      databases.db.prepare("INSERT INTO native_directory_existing_import_events(import_id,state,detail_json) VALUES(?,'acquired',?)")
        .bind(ar.importId, JSON.stringify({ commandId: command, expectedGeneration: "5", nextGeneration: "6" })),
      databases.db.prepare("UPDATE native_directory_existing_import_source_cursors SET generation='6',last_import_id=? WHERE batch_id=? AND source_id=?")
        .bind(ar.importId, ar.batchId, ar.sourceId),
    ])).rejects.toThrow();
    expect((await databases.db.prepare("SELECT * FROM native_directory_existing_import_source_cursors WHERE batch_id=? AND source_id=?")
      .bind(ar.batchId, ar.sourceId).all()).results).toEqual(before);
  });
});
