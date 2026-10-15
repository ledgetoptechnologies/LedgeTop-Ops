import assert from "node:assert/strict";
import test from "node:test";
import { assertReadOnlyQuery, createD1QueryRunner, parseArguments, runPostflight } from "./staging-ops-project-v2-postflight-readback.mjs";

const externalProjectId = "ops-joined-acceptance-review01:project:11111111-1111-4111-8111-111111111111";
const sourceId = "project-alpha:staging";
const sourceInstanceId = "22222222-2222-4222-8222-222222222222";
const applicationId = "33333333-3333-4333-8333-333333333333";
const projectPublicId = "44444444444444444444444444444444";
const historyEpochId = "55555555-5555-4555-8555-555555555555";
const env = { OPS_PROJECT_ALPHA_SOURCE_ID: sourceId, OPS_PROJECT_ALPHA_APPLICATION_ID: applicationId,
  CLOUDFLARE_API_TOKEN: "private-token-must-not-appear", OPS_STAGING_D1_ENVIRONMENT: "staging",
  CLOUDFLARE_ACCOUNT_ID: "b".repeat(32), OPS_STAGING_D1_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
  OPS_STAGING_D1_DATABASE_NAME: "ops-review-staging", OPS_STAGING_D1_BINDING: "OPS_DB" };

function row(overrides = {}) {
  return { operations_row_count: 1, mapping_row_count: 1,
    operations_source_id: sourceId, operations_source_instance_id: sourceInstanceId,
    operations_application_id: applicationId, operations_project_public_id: projectPublicId,
    operations_history_epoch_id: historyEpochId, mapping_source_id: sourceId,
    mapping_source_instance_id: sourceInstanceId, mapping_application_id: applicationId,
    mapping_project_public_id: projectPublicId, mapping_history_epoch_id: historyEpochId, ...overrides };
}

function indexes() {
  return [
    { table_name: "operations_shared_projects", index_name: "sqlite_autoindex_operations_shared_projects_1", origin: "pk", unique_flag: 1, seqno: 0, column_name: "external_project_id" },
    { table_name: "operations_shared_projects", index_name: "sqlite_autoindex_operations_shared_projects_2", origin: "u", unique_flag: 1, seqno: 0, column_name: "source_instance_id" },
    { table_name: "operations_shared_projects", index_name: "sqlite_autoindex_operations_shared_projects_2", origin: "u", unique_flag: 1, seqno: 1, column_name: "project_alpha_public_id" },
    { table_name: "operations_shared_projects", index_name: "sqlite_autoindex_operations_shared_projects_2", origin: "u", unique_flag: 1, seqno: 2, column_name: "history_epoch_id" },
    { table_name: "project_alpha_project_mappings", index_name: "sqlite_autoindex_project_alpha_project_mappings_1", origin: "pk", unique_flag: 1, seqno: 0, column_name: "external_project_id" },
    { table_name: "project_alpha_project_mappings", index_name: "sqlite_autoindex_project_alpha_project_mappings_4", origin: "u", unique_flag: 1, seqno: 0, column_name: "source_instance_id" },
    { table_name: "project_alpha_project_mappings", index_name: "sqlite_autoindex_project_alpha_project_mappings_4", origin: "u", unique_flag: 1, seqno: 1, column_name: "project_alpha_public_id" },
  ];
}

test("requires explicit opt-in and the exact synthetic external project ID parameter", () => {
  assert.deepEqual(parseArguments(["--execute-readback", "--external-project-id", externalProjectId]),
    { executeReadback: true, externalProjectId });
  assert.throws(() => parseArguments(["--external-project-id", externalProjectId]), /execute_readback_required/);
  assert.throws(() => parseArguments(["--execute-readback", "--external-project-id", "customer-project"]),
    /invalid_synthetic_external_project_id/);
  assert.throws(() => parseArguments(["--execute-readback", "--external-project-id", externalProjectId, "--extra"]),
    /unknown_argument/);
});

test("queries only the fixed staging D1 endpoint with bound parameters and requires no-change metadata", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => ({ success: true, result: [{ success: true, results: [{ count: 1 }],
      meta: { changed_db: false, changes: 0 } }] }) };
  };
  const target = { environment: "staging", accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env.OPS_STAGING_D1_DATABASE_ID, databaseName: env.OPS_STAGING_D1_DATABASE_NAME, binding: "OPS_DB" };
  const query = createD1QueryRunner({ fetchImpl, token: env.CLOUDFLARE_API_TOKEN, target });
  assert.deepEqual(await query({ name: "bound", sql: "SELECT count(*) AS count FROM operations_shared_projects WHERE external_project_id=?",
    params: [externalProjectId] }), [{ count: 1 }]);
  assert.equal(requests[0].url, `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`
    + `/d1/database/${env.OPS_STAGING_D1_DATABASE_ID}/query`);
  assert.deepEqual(JSON.parse(requests[0].init.body).params, [externalProjectId]);
  assert.equal(requests[0].init.headers.authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  assert.throws(() => assertReadOnlyQuery("UPDATE operations_shared_projects SET name='x'"), /strictly_read_only/);

  for (const meta of [{ changed_db: true, changes: 0 }, { changed_db: false, changes: 1 }, { changed_db: false }]) {
    const changed = createD1QueryRunner({ token: "token", target, fetchImpl: async () => ({ ok: true,
      json: async () => ({ success: true, result: [{ success: true, results: [], meta }] }) }) });
    await assert.rejects(changed({ name: "changed", sql: "SELECT 1", params: [] }), /mutation_metadata/);
  }
});

test("passes only one joined row per table with matching identities and required unique indexes", async () => {
  const requests = [];
  const responses = [[row()], indexes()];
  const result = await runPostflight({ executeReadback: true, externalProjectId, env }, { fetchImpl: async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ success: true, result: [{ success: true,
      results: responses.shift(), meta: { changed_db: false, changes: 0 } }] }) };
  } });
  assert.deepEqual(requests[0].body.params, [externalProjectId]);
  assert.deepEqual(requests[1].body.params, []);
  assert.equal(requests.every(request => request.url.includes(`/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/`)), true);
  assert.deepEqual(result.rowCounts, { operationsSharedProjects: 1, projectAlphaProjectMappings: 1 });
  assert.equal(result.requiredUniqueIndexCount, 4);
  assert.equal(result.readOnlyMetadataVerified, true);
  const serialized = JSON.stringify(result);
  for (const privateValue of [externalProjectId, sourceId, sourceInstanceId, applicationId, projectPublicId,
    historyEpochId, env.CLOUDFLARE_API_TOKEN]) assert.equal(serialized.includes(privateValue), false);
});

test("fails closed on duplicate or missing rows, identity drift, and missing uniqueness", async () => {
  const scenarios = [
    { candidate: row({ operations_row_count: 2 }), expected: /operations_row_count_not_one/ },
    { candidate: row({ mapping_row_count: 0 }), expected: /mapping_row_count_not_one/ },
    { candidate: row({ mapping_history_epoch_id: "66666666-6666-4666-8666-666666666666" }), expected: /joined_identity_mismatch/ },
    { candidate: row({ operations_source_id: "project-alpha:wrong", mapping_source_id: "project-alpha:wrong" }), expected: /source_identity_mismatch/ },
  ];
  for (const scenario of scenarios) {
    await assert.rejects(runPostflight({ executeReadback: true, externalProjectId, env }, { query: async request => request.name === "rows"
      ? [scenario.candidate] : indexes() }), scenario.expected);
  }
  await assert.rejects(runPostflight({ executeReadback: true, externalProjectId, env }, { query: async request => request.name === "rows"
    ? [row()] : indexes().filter(index => index.index_name !== "sqlite_autoindex_project_alpha_project_mappings_4") }),
  /required_unique_index_missing/);
  await assert.rejects(runPostflight({ externalProjectId, env }, { query: async () => { throw new Error("must not run"); } }),
    /execute_readback_required/);
});
