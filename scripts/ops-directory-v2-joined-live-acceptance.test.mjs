import test from "node:test";
import assert from "node:assert/strict";
import { DirectoryJoinedAcceptanceError, parseDirectoryJoinedAcceptanceConfig,
  runDirectoryJoinedAcceptance } from "./ops-directory-v2-joined-live-acceptance.mjs";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const opsDatabase = STAGING_INVENTORY.operations.d1_databases.find(database => database.binding === "OPS_DB");

const env = {
  OPS_BASE_URL: "https://ops-staging.ledgetopdroneservices.com",
  OPS_DIRECTORY_ACCEPTANCE_ALLOW_MUTATIONS: "allow",
  OPS_DIRECTORY_ACCEPTANCE_PREFIX: "ops-directory-acceptance-test",
  OPS_DIRECTORY_ACCEPTANCE_SOURCE_ID: "project-alpha:staging",
  OPS_DIRECTORY_ACCEPTANCE_BUSINESS_AREA_ID: "drone",
  OPS_DIRECTORY_ACCEPTANCE_DIVISION_ID: "none",
  OPS_DIRECTORY_ACCEPTANCE_POLL_INTERVAL_MS: "100",
  OPS_DIRECTORY_ACCEPTANCE_TIMEOUT_MS: "2000",
  OPS_SESSION_COOKIE: "CF_Authorization=redacted-test-cookie",
  OPS_DIRECTORY_ACCEPTANCE_PUBLIC_LINK_URL: "https://delivery-staging.ledgetopdroneservices.com/s/sentinel",
  CLOUDFLARE_API_TOKEN: "redacted-d1-token",
  OPS_STAGING_D1_ENVIRONMENT: "staging",
  CLOUDFLARE_ACCOUNT_ID: STAGING_ACCOUNT_ID,
  OPS_STAGING_D1_DATABASE_ID: opsDatabase.database_id,
  OPS_STAGING_D1_DATABASE_NAME: opsDatabase.database_name,
  OPS_STAGING_D1_BINDING: "OPS_DB",
};

const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const write = (body, status, replayed, version) => ({ status, recordId: body.mutationId, kind: "client", version, replayed,
  destinations: [{ sourceId: env.OPS_DIRECTORY_ACCEPTANCE_SOURCE_ID, state: status === "written" ? "acknowledged" : "pending" }] });

function acceptanceFetcher(options = {}) {
  const calls = [], bodies = new Map(); let createReplays = 0, updateReplays = 0;
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname;
    calls.push({ path, method: init.method, headers: { ...init.headers } });
    if (url === env.OPS_DIRECTORY_ACCEPTANCE_PUBLIC_LINK_URL) {
      const changed = options.changedPublicLink && calls.filter(call => call.path === path).length > 1;
      return new Response(changed ? "changed-public-link" : "stable-public-link", { status: 200,
        headers: { "content-type": "text/html" } });
    }
    if (parsed.hostname === "api.cloudflare.com") {
      assert.equal(parsed.pathname, `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`
        + `/d1/database/${env.OPS_STAGING_D1_DATABASE_ID}/query`);
      assert.equal(init.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
      const create = bodies.get("create"), update = bodies.get("update");
      const base = { record_count: 1, mapping_count: 1, exact_mapping_count: 1, collision_count: 0,
        record_id: create.mutationId, external_id: create.mutationId, project_alpha_public_id: "a".repeat(32),
        mapping_kind: "legacy", update_receipt_count: 1, binding_public_id: "a".repeat(32), binding_revision: "2" };
      return json(200, { success: true, result: [{ success: true, results: [{ ...base, ...(options.readback ?? {}) }],
        meta: { changed_db: false, changes: 0 } }] });
    }
    assert.equal(init.headers.Cookie, env.OPS_SESSION_COOKIE);
    assert.equal(init.headers.Origin, env.OPS_BASE_URL);
    if (path === "/api/session") return json(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true } });
    if (path === "/api/client-hub/directory/create-options") return json(200, { kind: "client", sources: [{ id: env.OPS_DIRECTORY_ACCEPTANCE_SOURCE_ID }],
      scopes: [{ id: env.OPS_DIRECTORY_ACCEPTANCE_BUSINESS_AREA_ID, divisions: [] }] });
    if (init.method === "GET") {
      const recordId = path.split("/").at(-1), created = bodies.get("create"), updated = bodies.get("update");
      const profile = updated ? { ...updated.profile, clientType: "unknown" } : created.profile;
      return json(200, { recordId, kind: "client", version: updated ? 2 : 1, profile, scopes: created.scopes,
        linkage: "standalone", relationship: { version: 1, organization: null, organizations: [] }, editing: { available: true, reason: null } });
    }
    assert.equal(init.headers["X-CSRF-Token"], "csrf-test-token-1234");
    const body = JSON.parse(init.body); assert.equal(init.headers["Idempotency-Key"], body.mutationId);
    if (path.endsWith("/create-admissions")) {
      const original = bodies.get("admission");
      if (!original) { bodies.set("admission", body); return json(200, { status: "prepared" }); }
      return JSON.stringify(original) === JSON.stringify(body) ? json(200, { status: "prepared" })
        : json(409, { status: "conflict", reason: "idempotency_body_conflict" });
    }
    if (init.method === "POST") {
      const original = bodies.get("create");
      if (!original) { bodies.set("create", body); return json(202, write(body, "pending", false, 1)); }
      if (body.mutationId === original.mutationId && JSON.stringify(body) !== JSON.stringify(original))
        return json(409, { status: "conflict", reason: "idempotency_body_conflict" });
      createReplays += 1;
      return createReplays < 2 ? json(202, write(body, "pending", true, 1)) : json(200, write(body, "written", true, 1));
    }
    const original = bodies.get("update");
    if (!original) { bodies.set("update", body); return json(202, write({ mutationId: bodies.get("create").mutationId }, "pending", false, 2)); }
    if (body.mutationId === original.mutationId && JSON.stringify(body) !== JSON.stringify(original))
      return json(409, { status: "conflict", reason: "idempotency_body_conflict" });
    if (body.mutationId !== original.mutationId)
      return json(409, { status: "conflict", reason: "stale_local_version" });
    updateReplays += 1;
    const resultBody = { mutationId: bodies.get("create").mutationId };
    return updateReplays < 2 ? json(202, write(resultBody, "pending", true, 2)) : json(200, write(resultBody, "written", true, 2));
  };
  return { fetcher, calls };
}

test("config is staging-only and requires explicit source, business area, division selector, mutation gate, and session", async () => {
  assert.equal((await parseDirectoryJoinedAcceptanceConfig({ ...env, OPS_DIRECTORY_ACCEPTANCE_ALLOW_MUTATIONS: "" })).mutate, false);
  await assert.rejects(() => parseDirectoryJoinedAcceptanceConfig({ ...env, OPS_BASE_URL: "https://ops.ledgetopdroneservices.com" }),
    { code: "production_or_noncanonical_operations_origin" });
  await assert.rejects(() => parseDirectoryJoinedAcceptanceConfig({ ...env, OPS_DIRECTORY_ACCEPTANCE_SOURCE_ID: "" }),
    { code: "missing_ops_directory_acceptance_source_id" });
  await assert.rejects(() => parseDirectoryJoinedAcceptanceConfig({ ...env, OPS_DIRECTORY_ACCEPTANCE_BUSINESS_AREA_ID: "" }),
    { code: "missing_ops_directory_acceptance_business_area_id" });
  await assert.rejects(() => parseDirectoryJoinedAcceptanceConfig({ ...env, OPS_DIRECTORY_ACCEPTANCE_DIVISION_ID: "" }),
    { code: "missing_ops_directory_acceptance_division_id" });
  await assert.rejects(() => parseDirectoryJoinedAcceptanceConfig({ ...env,
    OPS_DIRECTORY_ACCEPTANCE_PUBLIC_LINK_URL: "https://example.com/s/production" }),
  { code: "production_or_nonstaging_public_link" });
  await assert.rejects(() => parseDirectoryJoinedAcceptanceConfig({ ...env, CLOUDFLARE_API_TOKEN: "" }),
    { code: "missing_cloudflare_api_token" });
  await assert.rejects(() => parseDirectoryJoinedAcceptanceConfig({ ...env, OPS_SESSION_COOKIE: "" }), { code: "operations_session_required" });
  const config = await parseDirectoryJoinedAcceptanceConfig(env);
  assert.equal(config.sourceId, "project-alpha:staging"); assert.equal(config.businessAreaId, "drone"); assert.equal(config.divisionId, null);
  assert.equal(config.d1Target.databaseName, opsDatabase.database_name);
});

test("joined Directory runner proves admission/create/update replay, body conflict, cron acknowledgement, exact read, and stale version", async () => {
  const config = await parseDirectoryJoinedAcceptanceConfig(env), { fetcher, calls } = acceptanceFetcher();
  let now = 1_000;
  const report = await runDirectoryJoinedAcceptance(config, { fetcher, now: () => now, sleep: async ms => { now += ms; } });
  assert.equal(report.status, "passed");
  assert.equal(report.admission.changedBodyConflict.reason, "idempotency_body_conflict");
  assert.equal(report.create.acknowledgement.outcome.status, "written");
  assert.equal(report.create.acknowledgement.polls, 2);
  assert.equal(report.create.exactRead.version, 1);
  assert.match(report.create.exactRead.profileSha256, /^[a-f0-9]{64}$/);
  assert.match(report.create.exactRead.scopesSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.update.acknowledgement.outcome.status, "written");
  assert.equal(report.update.changedBodyConflict.reason, "idempotency_body_conflict");
  assert.equal(report.update.staleVersionConflict.reason, "stale_local_version");
  assert.equal(report.update.exactRead.version, 2);
  assert.match(report.update.exactRead.profileSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(report.update.exactRead.profileSha256, report.create.exactRead.profileSha256);
  assert.equal(report.update.exactRead.scopesSha256, report.create.exactRead.scopesSha256);
  assert.equal(report.destinationReadback.mappingCount, 1);
  assert.equal(report.destinationReadback.collisionCount, 0);
  assert.equal(report.destinationReadback.bindingRevision, "2");
  assert.equal(report.publicLink.before.bodySha256, report.publicLink.after.bodySha256);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(env.OPS_SESSION_COOKIE), false);
  assert.equal(serialized.includes(env.CLOUDFLARE_API_TOKEN), false);
  assert.equal(serialized.includes(env.OPS_DIRECTORY_ACCEPTANCE_PUBLIC_LINK_URL), false);
  assert.equal(serialized.includes("csrf-test-token"), false);
  assert.equal(serialized.includes("@"), false);
  assert.equal(serialized.includes(env.OPS_DIRECTORY_ACCEPTANCE_SOURCE_ID), false);
  assert.equal(serialized.includes(env.OPS_DIRECTORY_ACCEPTANCE_PREFIX), false);
  assert.equal(calls.filter(call => call.path === "/api/session").length, 1);
  assert.equal(calls[2].path, "/api/client-hub/directory/create-options");
});

test("joined Directory runner fails closed on missing, duplicate, mismatched, or colliding destination identity", async () => {
  const config = await parseDirectoryJoinedAcceptanceConfig(env);
  for (const [readback, code] of [
    [{ mapping_count: 0, exact_mapping_count: 0 }, "destination_mapping_missing"],
    [{ mapping_count: 2, exact_mapping_count: 2 }, "destination_mapping_duplicate"],
    [{ external_id: "wrong-external-id", exact_mapping_count: 0 }, "destination_mapping_mismatch"],
    [{ collision_count: 1 }, "destination_mapping_collision"],
  ]) {
    const { fetcher } = acceptanceFetcher({ readback }); let now = 0;
    await assert.rejects(() => runDirectoryJoinedAcceptance(config,
      { fetcher, now: () => now, sleep: async ms => { now += ms; } }), { code });
  }
});

test("joined Directory runner rejects missing or inconsistent binding revision evidence", async () => {
  const config = await parseDirectoryJoinedAcceptanceConfig(env);
  for (const readback of [{ binding_revision: null }, { binding_revision: "1" }, { binding_revision: "3" },
    { binding_revision: "2", binding_public_id: "b".repeat(32) }, { update_receipt_count: 2 }]) {
    const { fetcher } = acceptanceFetcher({ readback }); let now = 0;
    await assert.rejects(() => runDirectoryJoinedAcceptance(config,
      { fetcher, now: () => now, sleep: async ms => { now += ms; } }), { code: "destination_binding_revision_mismatch" });
  }
});

test("joined Directory runner fails closed when the public-link sentinel changes", async () => {
  const config = await parseDirectoryJoinedAcceptanceConfig(env), { fetcher } = acceptanceFetcher({ changedPublicLink: true });
  let now = 0;
  await assert.rejects(() => runDirectoryJoinedAcceptance(config,
    { fetcher, now: () => now, sleep: async ms => { now += ms; } }), { code: "public_link_changed" });
});

test("runner refuses mutation without the exact opt-in and fails closed on timeout or malformed output", async () => {
  await assert.rejects(() => runDirectoryJoinedAcceptance({ origin: env.OPS_BASE_URL, mutate: false }), { code: "mutation_allow_required" });
  const config = await parseDirectoryJoinedAcceptanceConfig({ ...env, OPS_DIRECTORY_ACCEPTANCE_TIMEOUT_MS: "100" });
  assert.equal(DirectoryJoinedAcceptanceError.prototype instanceof Error, true);
  let now = 0, creates = 0, admissionBody;
  await assert.rejects(() => runDirectoryJoinedAcceptance(config, { now: () => now, sleep: async ms => { now += ms; }, fetcher: async (url, init = {}) => {
    if (url === env.OPS_DIRECTORY_ACCEPTANCE_PUBLIC_LINK_URL)
      return new Response("stable-public-link", { status: 200, headers: { "content-type": "text/html" } });
    const path = new URL(url).pathname;
    if (path === "/api/session") return json(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true } });
    if (path === "/api/client-hub/directory/create-options") return json(200, { kind: "client", sources: [{ id: env.OPS_DIRECTORY_ACCEPTANCE_SOURCE_ID }],
      scopes: [{ id: env.OPS_DIRECTORY_ACCEPTANCE_BUSINESS_AREA_ID, divisions: [] }] });
    const body = JSON.parse(init.body);
    if (path.endsWith("/create-admissions")) {
      if (!admissionBody) { admissionBody = body; return json(200, { status: "prepared" }); }
      return JSON.stringify(admissionBody) === JSON.stringify(body) ? json(200, { status: "prepared" })
        : json(409, { status: "conflict", reason: "idempotency_body_conflict" });
    }
    creates += 1;
    return json(202, write(body, "pending", creates > 1, 1));
  } }), { code: "project_alpha_ack_timeout" });
});

test("bounded parser rejects an oversized response before accepting server output", async () => {
  const config = await parseDirectoryJoinedAcceptanceConfig(env);
  await assert.rejects(() => runDirectoryJoinedAcceptance(config, { fetcher: async () => new Response("x".repeat(70_000), { status: 200 }) }),
    { code: "response_too_large" });
});

test("runner checks actor-scoped source and scope options before attempting any mutation", async () => {
  const config = await parseDirectoryJoinedAcceptanceConfig(env);
  let mutations = 0;
  await assert.rejects(() => runDirectoryJoinedAcceptance(config, { fetcher: async (url, init = {}) => {
    if (url === env.OPS_DIRECTORY_ACCEPTANCE_PUBLIC_LINK_URL)
      return new Response("stable-public-link", { status: 200, headers: { "content-type": "text/html" } });
    const path = new URL(url).pathname;
    if (path === "/api/session") return json(200, { csrfToken: "csrf-test-token-1234", user: { isAdministrator: true } });
    if (path === "/api/client-hub/directory/create-options") return json(200, { kind: "client", sources: [], scopes: [] });
    if (init.method !== "GET") mutations += 1;
    return json(200, { status: "prepared" });
  } }), { code: "directory_source_not_offered" });
  assert.equal(mutations, 0);
});
