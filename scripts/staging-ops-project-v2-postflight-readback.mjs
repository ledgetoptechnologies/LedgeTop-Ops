import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseStagingCloudflareD1Target, stagingCloudflareD1QueryUrl } from "./staging-cloudflare-d1-target.mjs";

const SYNTHETIC_EXTERNAL_ID = /^ops-joined-acceptance-[a-z0-9][a-z0-9-]{2,60}:project:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const READ_ONLY = /^\s*SELECT\b/i;
const MUTATION = /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|REINDEX|PRAGMA)\b/i;

const ROW_QUERY = `SELECT
  (SELECT count(*) FROM operations_shared_projects WHERE external_project_id=selected.external_project_id) AS operations_row_count,
  (SELECT count(*) FROM project_alpha_project_mappings WHERE external_project_id=selected.external_project_id) AS mapping_row_count,
  (SELECT source_id FROM operations_shared_projects WHERE external_project_id=selected.external_project_id) AS operations_source_id,
  (SELECT source_instance_id FROM operations_shared_projects WHERE external_project_id=selected.external_project_id) AS operations_source_instance_id,
  (SELECT application_id FROM operations_shared_projects WHERE external_project_id=selected.external_project_id) AS operations_application_id,
  (SELECT project_alpha_public_id FROM operations_shared_projects WHERE external_project_id=selected.external_project_id) AS operations_project_public_id,
  (SELECT history_epoch_id FROM operations_shared_projects WHERE external_project_id=selected.external_project_id) AS operations_history_epoch_id,
  (SELECT source_id FROM project_alpha_project_mappings WHERE external_project_id=selected.external_project_id) AS mapping_source_id,
  (SELECT source_instance_id FROM project_alpha_project_mappings WHERE external_project_id=selected.external_project_id) AS mapping_source_instance_id,
  (SELECT application_id FROM project_alpha_project_mappings WHERE external_project_id=selected.external_project_id) AS mapping_application_id,
  (SELECT project_alpha_public_id FROM project_alpha_project_mappings WHERE external_project_id=selected.external_project_id) AS mapping_project_public_id,
  (SELECT history_epoch_id FROM project_alpha_project_mappings WHERE external_project_id=selected.external_project_id) AS mapping_history_epoch_id
FROM (SELECT ? AS external_project_id) AS selected`;

const INDEX_QUERY = `SELECT table_name,index_name,origin,unique_flag,seqno,column_name
FROM (
  SELECT 'operations_shared_projects' AS table_name,index_list.name AS index_name,index_list.origin,
    index_list."unique" AS unique_flag,index_info.seqno,index_info.name AS column_name
  FROM pragma_index_list('operations_shared_projects') AS index_list
  JOIN pragma_index_info(index_list.name) AS index_info
  UNION ALL
  SELECT 'project_alpha_project_mappings' AS table_name,index_list.name AS index_name,index_list.origin,
    index_list."unique" AS unique_flag,index_info.seqno,index_info.name AS column_name
  FROM pragma_index_list('project_alpha_project_mappings') AS index_list
  JOIN pragma_index_info(index_list.name) AS index_info
)
ORDER BY table_name,index_name,seqno`;

const REQUIRED_UNIQUE_INDEXES = Object.freeze({
  operations_shared_projects: Object.freeze([
    "external_project_id",
    "source_instance_id,project_alpha_public_id,history_epoch_id",
  ]),
  project_alpha_project_mappings: Object.freeze([
    "external_project_id",
    "source_instance_id,project_alpha_public_id",
  ]),
});

function fail(code) { throw new Error(code); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function exactString(value, pattern, code) {
  if (typeof value !== "string" || value !== value.trim() || !pattern.test(value)) fail(code);
  return value;
}

export function parseArguments(argv) {
  let execute = false;
  let externalProjectId;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute-readback") {
      if (execute) fail("duplicate_execute_readback");
      execute = true;
      continue;
    }
    if (argument !== "--external-project-id") fail("unknown_argument");
    if (externalProjectId !== undefined) fail("duplicate_external_project_id");
    externalProjectId = argv[++index];
    if (!externalProjectId || externalProjectId.startsWith("--")) fail("external_project_id_required");
  }
  if (!execute) fail("execute_readback_required");
  exactString(externalProjectId, SYNTHETIC_EXTERNAL_ID, "invalid_synthetic_external_project_id");
  return Object.freeze({ executeReadback: true, externalProjectId });
}

export function assertReadOnlyQuery(sql) {
  if (typeof sql !== "string" || !READ_ONLY.test(sql) || sql.includes(";") || /--|\/\*/.test(sql) || MUTATION.test(sql))
    fail("query_not_strictly_read_only");
}

export function createD1QueryRunner({ fetchImpl = globalThis.fetch, token, target }) {
  if (typeof fetchImpl !== "function" || typeof token !== "string" || token.length < 1) fail("readback_transport_not_configured");
  const endpoint = stagingCloudflareD1QueryUrl(target);
  return async ({ name, sql, params = [] }) => {
    assertReadOnlyQuery(sql);
    if (!Array.isArray(params) || params.some(value => typeof value !== "string")) fail("invalid_query_parameters");
    let response;
    try {
      response = await fetchImpl(endpoint, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json",
      }, body: JSON.stringify({ sql, params }) });
    } catch { fail(`query_${name}_transport_failed`); }
    let payload;
    try { payload = await response.json(); }
    catch { fail(`query_${name}_invalid_response`); }
    const result = Array.isArray(payload?.result) && payload.result.length === 1 ? payload.result[0] : null;
    if (!response.ok || payload?.success !== true || result?.success !== true || !Array.isArray(result.results))
      fail(`query_${name}_failed`);
    if (result.meta?.changed_db !== false || result.meta?.changes !== 0)
      fail(`query_${name}_mutation_metadata`);
    return result.results;
  };
}

function expectedIdentity(env) {
  return Object.freeze({
    sourceId: exactString(env.OPS_PROJECT_ALPHA_SOURCE_ID, SOURCE_ID, "invalid_expected_source_id"),
    applicationId: exactString(env.OPS_PROJECT_ALPHA_APPLICATION_ID, UUID_V4, "invalid_expected_application_id"),
  });
}
function verifyRows(rows, expected) {
  if (!Array.isArray(rows) || rows.length !== 1) fail("invalid_row_readback");
  const row = rows[0];
  if (row?.operations_row_count !== 1) fail("operations_row_count_not_one");
  if (row?.mapping_row_count !== 1) fail("mapping_row_count_not_one");
  const operations = [row.operations_source_id, row.operations_source_instance_id, row.operations_application_id,
    row.operations_project_public_id, row.operations_history_epoch_id];
  const mapping = [row.mapping_source_id, row.mapping_source_instance_id, row.mapping_application_id,
    row.mapping_project_public_id, row.mapping_history_epoch_id];
  if (operations.some((value, index) => value !== mapping[index])) fail("joined_identity_mismatch");
  if (operations[0] !== expected.sourceId) fail("source_identity_mismatch");
  if (operations[2] !== expected.applicationId) fail("application_identity_mismatch");
  exactString(operations[1], UUID_V4, "invalid_source_instance_identity");
  exactString(operations[3], PUBLIC_ID, "invalid_project_public_identity");
  exactString(operations[4], UUID_V4, "invalid_history_epoch_identity");
  return sha256(operations.join("\0"));
}

function verifyIndexes(rows) {
  if (!Array.isArray(rows)) fail("invalid_index_readback");
  const indexes = new Map();
  for (const row of rows) {
    if (!Object.hasOwn(REQUIRED_UNIQUE_INDEXES, row?.table_name)) continue;
    if (row.unique_flag !== 1 || !["pk", "u"].includes(row.origin) || typeof row.index_name !== "string"
      || !Number.isSafeInteger(row.seqno) || row.seqno < 0 || typeof row.column_name !== "string") continue;
    const key = `${row.table_name}\0${row.index_name}`;
    const index = indexes.get(key) ?? { table: row.table_name, columns: [] };
    if (index.columns[row.seqno] !== undefined) fail("invalid_index_readback");
    index.columns[row.seqno] = row.column_name;
    indexes.set(key, index);
  }
  const observed = new Map();
  for (const index of indexes.values()) {
    if (index.columns.some(column => typeof column !== "string")) fail("invalid_index_readback");
    const values = observed.get(index.table) ?? new Set();
    values.add(index.columns.join(","));
    observed.set(index.table, values);
  }
  for (const [table, columns] of Object.entries(REQUIRED_UNIQUE_INDEXES)) {
    for (const required of columns) if (!observed.get(table)?.has(required)) fail("required_unique_index_missing");
  }
  return Object.values(REQUIRED_UNIQUE_INDEXES).reduce((total, indexes) => total + indexes.length, 0);
}

export async function runPostflight({ executeReadback, externalProjectId, env = process.env }, dependencies = {}) {
  if (executeReadback !== true) fail("execute_readback_required");
  exactString(externalProjectId, SYNTHETIC_EXTERNAL_ID, "invalid_synthetic_external_project_id");
  const expected = expectedIdentity(env);
  const target = parseStagingCloudflareD1Target(env, "OPS_DB");
  const query = dependencies.query ?? createD1QueryRunner({ fetchImpl: dependencies.fetchImpl,
    token: env.CLOUDFLARE_API_TOKEN, target });
  const rows = await query({ name: "rows", sql: ROW_QUERY, params: [externalProjectId] });
  const identitySha256 = verifyRows(rows, expected);
  const indexes = await query({ name: "indexes", sql: INDEX_QUERY, params: [] });
  const requiredUniqueIndexCount = verifyIndexes(indexes);
  return Object.freeze({ schemaVersion: 1, environment: "staging", database: target.databaseName,
    status: "passed", externalProjectIdSha256: sha256(externalProjectId), identitySha256,
    rowCounts: Object.freeze({ operationsSharedProjects: 1, projectAlphaProjectMappings: 1 }),
    identitiesMatch: true, requiredUniqueIndexCount, readOnlyMetadataVerified: true,
    secretsAndPiiExcluded: true,
  });
}
export async function run(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const options = parseArguments(argv);
  const result = await runPostflight({ ...options, env }, dependencies);
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch(error => {
    console.error(`staging Project-v2 postflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}
