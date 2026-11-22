// QA fixture for #698 (not for merge). Offline readback of the Viewer side of the fixture.
//   node qa/sharing-698/viewer-readback.mjs        (needs `npm ci` in apps/viewer; exit 1 on any failure)
// Loads seed-viewer.sql into an in-memory Viewer database built by the Viewer's own
// migrations (schema 83). With the Viewer's own repository code it then checks the
// following, and prints which Viewer lookups each of the 46 contract cases depends on.
//   - the closed storage manifest (viewer-manifest.json) and the asset rows agree;
//   - the seed's publication equals what ProcessingRepository.publishAttemptAtomic writes;
//   - the catalog lookups behind GET /api/v1/client-delivery-catalog and /client-delivery-projects
//     return exactly the registered project, task, model and model version;
//   - the session lookups behind POST /api/v1/models/:id/sessions and DELETE
//     /api/v1/published-sessions/source-authorization accept, revoke and then refuse a
//     direct_client_grant authority for that model.
// No HTTP listener, network, Viewer runtime or storage outside this folder is used.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(fixtureDir, "..", "..");
const viewerRequire = createRequire(path.join(repoRoot, "apps", "viewer", "package.json"));
const { MIGRATIONS, applyMigrations } = viewerRequire("./server/database.js");
const { ViewerRepository } = viewerRequire("./server/repository.js");
const { ProcessingRepository } = viewerRequire("./server/processingRepository.js");

export const VIEWER_SCHEMA = { version: 83, name: "provider_engine_processing_elapsed" };
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const contract = () => JSON.parse(readFileSync(path.join(fixtureDir, "contract.json"), "utf8"));
const schemaText = db => db.prepare("SELECT group_concat(type||':'||name||':'||coalesce(sql,''),'|') s FROM (SELECT * FROM sqlite_master ORDER BY type,name)").get().s;

/** A fresh in-memory Viewer database at schema 83 with the seed (whole, or Part 1 only). */
export function buildViewerDatabase({ publication = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  const head = sqlite.prepare("SELECT version,name FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
  const before = schemaText(sqlite);
  const seed = readFileSync(path.join(fixtureDir, "seed-viewer.sql"), "utf8").replace(/\r\n/g, "\n");
  const marker = seed.indexOf("\n-- @@publication\n");
  if (marker < 0) throw new Error("seed-viewer.sql has no publication marker");
  sqlite.exec(publication ? seed : seed.slice(0, marker));
  return { sqlite, head: { ...head }, seedChangedSchema: schemaText(sqlite) !== before,
    repository: new ViewerRepository(sqlite), processing: new ProcessingRepository(sqlite) };
}

function storageFiles(root, relative = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...storageFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
    else throw new Error(`special file in viewer-storage: ${rel}`);
  }
  return files;
}

/** The catalog response exactly as clientDeliveryCatalog.js assembles it. */
export function catalogResponse(processing, projectId, { taskId, limit = 50 } = {}) {
  return processing.transaction(() => {
    const project = processing.getProject(projectId);
    if (!project || project.status !== "active") return null;
    const page = taskId === undefined
      ? processing.listActivePublishedProjectTasksPage(projectId, { limit, cursor: null, strictPublished: true })
      : { items: [processing.getActivePublishedProjectTask(projectId, taskId, { strictPublished: true })].filter(Boolean), nextCursor: null };
    if (taskId !== undefined && page.items.length !== 1) return null;
    return { schemaVersion: 1, project: { id: project.id, displayName: project.displayName },
      tasks: page.items.map(task => ({ id: task.taskId, displayName: task.taskDisplayName, modelId: task.modelId,
        modelVersionId: task.modelVersionId, modelTitle: task.modelDisplayName, publishedAt: task.publishedAt })),
      nextCursor: page.nextCursor };
  });
}

/** The three Viewer service calls Ops makes for direct shares, answered by the Viewer's own
 * repository code over the seeded database (the route bodies, without HTTP or service auth).
 * A refusal throws an Error whose `viewerCode` is the code the Ops service client would see. */
export function viewerServiceFromSeed(viewer, { sessionTtlSeconds = 1800, grantTtlSeconds = 120 } = {}) {
  const refuse = (viewerCode, message) => { throw Object.assign(new Error(message), { viewerCode }); };
  return {
    clientDeliveryCatalog(input) {
      const result = catalogResponse(viewer.processing, input.projectId, { taskId: input.taskId, limit: input.limit ?? 25 });
      return result ?? refuse("not_found", "Published delivery unavailable");
    },
    createSession(input) {
      // apiV1.js POST /api/v1/models/:id/sessions: ready model, active version, source authority, then grant.
      const model = viewer.repository.getModel(input.modelId);
      if (!model || model.status !== "ready" || !model.activeVersion) return refuse("not_found", "ready model not found"); // route: 404
      if (input.modelVersionId !== model.activeVersionId) return refuse("conflict", "requested model version is not active"); // route: 409
      const requested = Date.parse(input.authorizationExpiresAt);
      const authorizedUntil = new Date(Math.min(requested, Date.now() + sessionTtlSeconds * 1000)).toISOString();
      const expiresAt = new Date(Math.min(Date.parse(authorizedUntil), Date.now() + grantTtlSeconds * 1000)).toISOString();
      let grant;
      try {
        grant = viewer.repository.createSessionGrantAudited({ modelId: model.id, modelVersionId: model.activeVersionId, sessionMode: "published",
          sourceAuthorization: input.sourceAuthorization ?? null, subject: input.subject, audience: input.audience,
          permissions: { ...input.permissions, __authorizedUntil: authorizedUntil, __versionId: model.activeVersionId },
          displayUnits: input.displayUnits || "imperial", expiresAt },
        { actorType: "service", actorId: "qa698-readback", action: "session.created", entityType: "model", entityId: model.id });
      } catch (error) {
        if (error?.code === "source_authorization_revoked") return refuse("conflict", "sourceAuthorization is revoked"); // route: 409
        throw error;
      }
      const base = "https://viewer.example.test"; // the route uses config.publicBaseUrl
      return { grant: grant.id, grantExpiresAt: expiresAt, sessionTtlSeconds, modelVersionId: model.activeVersionId,
        authorizationExpiresAt: authorizedUntil, redeemUrl: `${base}/api/v1/sessions/redeem`, embedUrl: `${base}/session/${encodeURIComponent(grant.id)}` };
    },
    revokePublishedSessionSourceAuthorization(input) {
      return viewer.repository.revokePublishedSessionsBySourceAuthorization({ sourceAuthorization: input.sourceAuthorization,
        audit: { actorType: "service", actorId: "qa698-readback", action: "published_session.source_authorization_revoked", entityType: "source_authorization" } });
    },
  };
}

const STABLE = {
  projects: "SELECT id,display_name,status,default_units,purged_at FROM projects",
  processing_tasks: "SELECT id,project_id,dataset_id,display_name,status,active_attempt_id,published_model_id,purged_at FROM processing_tasks",
  processing_attempts: "SELECT id,task_id,status,result_model_id,result_model_version_id,dataset_id,provider_id FROM processing_attempts",
  models: "SELECT id,provider,provider_model_id,display_name,status,active_version_id,unregistered_at FROM models",
  model_versions: "SELECT id,model_id,provider_version_id,source_locator_json,status FROM model_versions",
  model_outputs: "SELECT id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count FROM model_outputs",
  model_assets: "SELECT id,version_id,kind,root_key,relative_path,format,byte_size,storage_mode,published,source_attempt_id,sha256,manifest_sha256 FROM model_assets",
  audit_events: "SELECT actor_type,actor_id,action,entity_type,entity_id,details_json FROM audit_events WHERE action='processing_attempt.published'",
};
const snapshot = db => Object.fromEntries(Object.entries(STABLE).map(([table, sql]) => [table, db.prepare(`${sql} ORDER BY 1`).all().map(row => ({ ...row }))]));

/** Viewer calls each contract case makes, given the Ops and Client code at the pinned commit. */
export function viewerDependencies(caseItem) {
  const { method, path: route, expect } = caseItem;
  if (/^\/api\/client\/v2\/workspaces\/[^/]+\/viewer$/.test(route) && expect.status === 200 && (expect.len?.items ?? 0) > 0)
    return ["catalog(projectId, limit=25)"];
  if (/\/viewer\/\$\{grantId\}\/tasks\/[^/]+\/session$/.test(route) && expect.status === 201)
    return ["catalog(projectId, taskId, limit=1)", "POST /api/v1/models/:id/sessions (direct_client_grant)", "catalog(projectId, taskId, limit=1)"];
  // Create reaches the catalog after the replay receipt check; a replay (200) answers from the receipt, a duplicate (409) after the catalog.
  if (route === "/api/viewer/direct-client-grants" && method === "POST" && [201, 409].includes(expect.status)) return ["catalog(projectId, limit=25)"];
  if (route.startsWith("/api/viewer/direct-client-grants/") && method === "DELETE" && expect.status === 200 && expect.equals?.replayed === false)
    return ["DELETE /api/v1/published-sessions/source-authorization (direct_client_grant)"];
  return [];
}

export function runViewerReadback() {
  const failures = [], check = (ok, message) => { if (!ok) failures.push(message); };
  const c = contract(), e = c.entities, manifest = JSON.parse(readFileSync(path.join(fixtureDir, "viewer-manifest.json"), "utf8"));
  const full = buildViewerDatabase();
  check(full.head.version === VIEWER_SCHEMA.version && full.head.name === VIEWER_SCHEMA.name, `Viewer schema head is ${JSON.stringify(full.head)}`);
  check(MIGRATIONS.at(-1).version === VIEWER_SCHEMA.version, "MIGRATIONS does not end at 83");
  check(!full.seedChangedSchema, "seed-viewer.sql changed the schema");
  check(full.sqlite.prepare("PRAGMA foreign_key_check").all().length === 0, "foreign key violations in the Viewer seed");
  check(full.sqlite.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "Viewer integrity_check failed");

  // Closed manifest: every file under viewer-storage is listed, with its exact size and digest; nothing else exists.
  const storageRoot = path.join(fixtureDir, "viewer-storage");
  const present = storageFiles(storageRoot).map(file => `viewer-storage/${file}`).sort();
  const listed = manifest.files.map(file => file.path).sort();
  check(JSON.stringify(present) === JSON.stringify(listed), `viewer-storage is not exactly the manifest: ${JSON.stringify({ present, listed })}`);
  for (const file of manifest.files) {
    const bytes = readFileSync(path.join(fixtureDir, file.path));
    check(bytes.length === file.bytes && statSync(path.join(fixtureDir, file.path)).size === file.bytes, `${file.path} size`);
    check(sha256(bytes) === file.sha256, `${file.path} sha256`);
    check(file.path === `viewer-storage/${file.rootKey}/${file.relativePath}`, `${file.path} root/relative path`);
  }
  for (const item of manifest.sources ?? []) {
    const bytes = readFileSync(path.join(fixtureDir, item.path), "utf8").replace(/\r\n/g, "\n");
    check(Buffer.byteLength(bytes) === item.bytes && sha256(bytes) === item.sha256, `${item.path} differs from the manifest`);
  }
  const assets = full.sqlite.prepare("SELECT * FROM model_assets WHERE version_id=?").all(e["viewer.modelVersion"]);
  check(assets.length === manifest.files.length, "asset rows and manifest files differ in number");
  for (const asset of assets) {
    const file = manifest.files.find(item => item.asset === Object.keys(e).find(name => e[name] === asset.id));
    check(Boolean(file) && file.rootKey === asset.root_key && file.relativePath === asset.relative_path
      && file.bytes === asset.byte_size && file.sha256 === asset.sha256 && asset.published === 1, `asset ${asset.id} does not match its manifest file`);
  }
  const output = full.sqlite.prepare("SELECT * FROM model_outputs WHERE id=?").get(e["viewer.modelVersion"]);
  const underOutput = manifest.files.filter(file => file.rootKey === output.root_key && file.relativePath.startsWith(`${output.relative_path}/`));
  check(output.byte_size === underOutput.reduce((sum, file) => sum + file.bytes, 0) && output.asset_count === assets.length, "output size/asset count do not match the manifest");

  // The seed's publication equals the Viewer's own publish path applied to Part 1.
  const viaProduct = buildViewerDatabase({ publication: false });
  const published = viaProduct.processing.publishAttemptAtomic(e["viewer.attempt"], ["glb"], { actorId: e["staff.admin"] });
  check(published?.modelVersionId === e["viewer.modelVersion"], "publishAttemptAtomic refused the Part 1 state");
  const expected = snapshot(viaProduct.sqlite), actual = snapshot(full.sqlite);
  for (const table of Object.keys(STABLE))
    check(JSON.stringify(actual[table]) === JSON.stringify(expected[table]), `${table} differs from the product publish path: ${JSON.stringify({ seed: actual[table], product: expected[table] })}`);

  // Catalog lookups.
  const want = { schemaVersion: 1, project: { id: c.viewer.project.id, displayName: c.viewer.project.displayName },
    tasks: [{ id: c.viewer.task.id, displayName: c.viewer.task.displayName, modelId: c.viewer.task.modelId, modelVersionId: c.viewer.task.modelVersionId,
      modelTitle: c.viewer.task.displayName, publishedAt: "2026-11-01T00:12:00.000Z" }], nextCursor: null };
  check([c.viewer.project.id, c.viewer.task.id, c.viewer.task.modelId, c.viewer.task.modelVersionId].join() ===
    [e["viewer.project"], e["viewer.task"], e["viewer.model"], e["viewer.modelVersion"]].join(), "contract viewer ids are not the registered entities");
  for (const [label, options] of [["project page, default limit 25 (create C4, duplicate C6, read R1)", { limit: 25 }], ["project page, route default limit 50", {}],
    ["exact task limit 1 (session R2)", { taskId: c.viewer.task.id, limit: 1 }]])
    check(JSON.stringify(catalogResponse(full.processing, c.viewer.project.id, options)) === JSON.stringify(want), `catalog ${label} differs`);
  check(catalogResponse(full.processing, c.viewer.project.id, { taskId: randomUUID() }) === null, "an unknown task must be 404");
  check(catalogResponse(full.processing, randomUUID()) === null, "an unknown project must be 404");
  const projects = full.processing.transaction(() => full.processing.listActivePublishedProjectsPage({ q: "", limit: 50 }));
  check(JSON.stringify(projects.items) === JSON.stringify([want.project]) && projects.nextCursor === null, "client-delivery-projects page differs");

  // Session authorization lookups, through the same functions the contract test uses for the Viewer service:
  // POST /api/v1/models/:id/sessions (R2) and DELETE /api/v1/published-sessions/source-authorization (V3).
  const service = viewerServiceFromSeed(full);
  const model = full.repository.getModel(c.viewer.task.modelId);
  check(model?.status === "ready" && model.activeVersionId === c.viewer.task.modelVersionId, "session route would not find a ready model at the registered version");
  const authority = { type: "direct_client_grant", id: randomUUID(), version: 1 }; // stands in for the grant id Ops creates at run time
  const sessionRequest = { modelId: c.viewer.task.modelId, modelVersionId: c.viewer.task.modelVersionId, subject: `client:${e["client.alpha"]}`,
    audience: "client", authorizationExpiresAt: new Date(Date.now() + 600_000).toISOString(), displayUnits: "imperial", sourceAuthorization: authority,
    permissions: { view: true, measure: true, cameras: false, download: false, personalMeasurements: true } };
  const session = service.createSession(sessionRequest);
  check(typeof session.grant === "string" && session.modelVersionId === c.viewer.task.modelVersionId, "session grant was not created");
  const refusedVersion = (() => { try { service.createSession({ ...sessionRequest, modelVersionId: randomUUID() }); return null; } catch (error) { return error.viewerCode; } })();
  check(refusedVersion === "conflict", "an inactive model version must be refused (409)");
  const revoked = service.revokePublishedSessionSourceAuthorization({ sourceAuthorization: authority });
  check(revoked.revokedGrants === 1 && revoked.revokedSessions === 0, `revocation result ${JSON.stringify(revoked)}`);
  check(full.repository.redeemSessionGrant(session.grant) === null, "a revoked grant must not redeem");
  const refused = (() => { try { service.createSession(sessionRequest); return null; } catch (error) { return error.viewerCode; } })();
  check(refused === "conflict", "a revoked direct_client_grant authority must be refused (409)");

  const dependencies = Object.fromEntries(c.cases.map(item => [item.id, viewerDependencies(item)]));
  check(c.cases.length === 46, `contract has ${c.cases.length} cases, not 46`);
  return { failures, schema: full.head, dependencies };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, schema, dependencies } = runViewerReadback();
  const used = Object.entries(dependencies).filter(([, calls]) => calls.length);
  console.log(JSON.stringify({ schema, casesUsingViewer: Object.fromEntries(used),
    casesWithoutViewer: Object.keys(dependencies).length - used.length }, null, 1));
  if (failures.length) { for (const failure of failures) console.error(`FAIL ${failure}`); process.exit(1); }
  console.log("viewer readback: OK");
}
