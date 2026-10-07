import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STAGING_DATABASE_TARGETS = Object.freeze(Object.fromEntries(
  Object.values(STAGING_INVENTORY).flatMap(config => (config.d1_databases ?? []).map(database => [database.binding, Object.freeze({
    databaseId: database.database_id,
    databaseName: database.database_name,
  })])),
));

function fail(code) { throw Object.assign(new Error(code), { code }); }

export function parseStagingCloudflareD1Target(env, expectedBinding) {
  if (env.OPS_STAGING_D1_ENVIRONMENT !== "staging") fail("invalid_staging_d1_target");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = env.OPS_STAGING_D1_DATABASE_ID;
  const databaseName = env.OPS_STAGING_D1_DATABASE_NAME;
  const binding = env.OPS_STAGING_D1_BINDING;
  const canonicalDatabase = STAGING_DATABASE_TARGETS[expectedBinding];
  if (!canonicalDatabase || accountId !== STAGING_ACCOUNT_ID || typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)
    || typeof databaseId !== "string" || !DATABASE_ID.test(databaseId)
    || databaseId !== canonicalDatabase.databaseId || databaseName !== canonicalDatabase.databaseName
    || binding !== expectedBinding) fail("invalid_staging_d1_target");
  return Object.freeze({ environment: "staging", accountId, databaseId, databaseName, binding });
}

export function stagingCloudflareD1QueryUrl(target) {
  if (!target || target.environment !== "staging" || target.accountId !== STAGING_ACCOUNT_ID
    || !ACCOUNT_ID.test(target.accountId) || !/^[A-Z][A-Z0-9_]{0,31}$/.test(target.binding)) fail("invalid_staging_d1_target");
  const canonicalDatabase = STAGING_DATABASE_TARGETS[target.binding];
  if (!canonicalDatabase || target.databaseId !== canonicalDatabase.databaseId || target.databaseName !== canonicalDatabase.databaseName) fail("invalid_staging_d1_target");
  return `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/query`;
}
