import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROFILE = "ops-two-source-staging-read-v1";
export const SECRET_NAME = "PROJECT_ALPHA_API_V2_CONNECTIONS";
export const INITIAL_READ_SCOPES = Object.freeze([
  "api.capabilities.read", "directory.inventory.read", "projects.inventory.read",
]);
export const STAGING_ORIGINS = Object.freeze({
  stageOne: "https://pa-staging.ledgetoptechnologies.com",
  stageTwo: "https://pa-stage-two.ledgetoptechnologies.com",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const invalid = () => { throw new Error("Two-source staging connection profile is invalid or incomplete"); };

// Only data properties are accepted; neither diagnostics nor validation should
// invoke accessors or echo arbitrary input (which may accidentally be a key).
function exact(value, fields) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key))
    && fields.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}

function parseMetadata(raw) {
  const parsed = JSON.parse(raw);
  // JSON.parse silently accepts duplicate property names. Reject ambiguous
  // operator declarations before validating their resulting object.
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);
  let index = 0;
  function visit() {
    const token = tokens[index++];
    if (token === "{") {
      const keys = new Set();
      while (tokens[index] !== "}") {
        const key = JSON.parse(tokens[index++]);
        if (keys.has(key)) invalid();
        keys.add(key); index++; visit();
        if (tokens[index] === ",") index++;
      }
      index++;
    } else if (token === "[") {
      while (tokens[index] !== "]") { visit(); if (tokens[index] === ",") index++; }
      index++;
    }
  }
  visit();
  return parsed;
}

/** Public operator metadata only. Declared scopes must subsequently be checked
 * against PA capabilities with the actual key; a local plan is not live proof. */
export function buildTwoSourceStagingConnectionPlan(metadata) {
  try {
    if (!exact(metadata, ["profile", "version", "sources"]) || metadata.profile !== PROFILE
      || metadata.version !== 1 || !exact(metadata.sources, ["stageOne", "stageTwo"])) invalid();
    const identities = { sourceId: new Set(), sourceInstanceId: new Set() };
    const sources = Object.entries(STAGING_ORIGINS).map(([stage, origin]) => {
      const source = metadata.sources[stage];
      if (!exact(source, ["sourceId", "enabled", "baseUrl", "sourceInstanceId", "applicationId", "historyEpoch", "scopes"])
        || source.enabled !== true || source.baseUrl !== origin || typeof source.sourceId !== "string"
        || !SOURCE_ID.test(source.sourceId) || (stage === "stageOne" && source.sourceId !== "project-alpha:staging")
        || !Array.isArray(source.scopes)
        || source.scopes.length !== INITIAL_READ_SCOPES.length
        || new Set(source.scopes).size !== INITIAL_READ_SCOPES.length
        || !INITIAL_READ_SCOPES.every(scope => source.scopes.includes(scope))) invalid();
      const normalized = {};
      for (const field of ["sourceId", "sourceInstanceId", "applicationId", "historyEpoch"]) {
        const value = source[field];
        if (typeof value !== "string" || (field !== "sourceId" && !UUID.test(value))) invalid();
        normalized[field] = field === "sourceId" ? value : value.toLowerCase();
        if (identities[field]?.has(normalized[field])) invalid();
        identities[field]?.add(normalized[field]);
      }
      // Match the runtime parser's per-connection identity invariant. PA-local
      // application/epoch IDs may repeat across independent installations.
      if (new Set([normalized.sourceInstanceId, normalized.applicationId, normalized.historyEpoch]).size !== 3) invalid();
      return Object.freeze({ stage, ...normalized, enabled: true, baseUrl: origin,
        scopes: Object.freeze([...INITIAL_READ_SCOPES]) });
    });
    return Object.freeze({ profile: PROFILE, version: 1, secretName: SECRET_NAME,
      sources: Object.freeze(sources), liveAcceptanceRequired: true });
  } catch { return invalid(); }
}

/** Private server/operator bridge only: send returned JSON directly through the
 * secret channel. Never log, persist in public metadata, or return to a browser.
 * This does not mutate a Worker, contact PA, or grant scopes to an existing key. */
export function buildTwoSourceStagingConnectionSecret(metadata, credentials) {
  const plan = buildTwoSourceStagingConnectionPlan(metadata);
  try {
    if (!exact(credentials, plan.sources.map(source => source.sourceId))) invalid();
    const instances = Object.fromEntries(plan.sources.map(source => {
      const credential = credentials[source.sourceId];
      if (!exact(credential, ["apiKey"]) || typeof credential.apiKey !== "string"
        || !/^[\x21-\x7e]{1,8192}$/.test(credential.apiKey)) invalid();
      const { sourceId, enabled, baseUrl, sourceInstanceId, applicationId, historyEpoch } = source;
      return [sourceId, { sourceId, enabled, baseUrl, apiKey: credential.apiKey,
        sourceInstanceId, applicationId, historyEpoch }];
    }));
    // Native staging login hosts are not behind Access. No Access credentials
    // are accepted by this profile, and there is no legacy snapshot fallback.
    return JSON.stringify({ version: 1, instances });
  } catch { return invalid(); }
}

export function run(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 3 || argv[0] !== "--check" || argv[1] !== "--values") invalid();
    const raw = fs.readFileSync(argv[2], "utf8");
    if (Buffer.byteLength(raw) > 32 * 1024) invalid();
    const plan = buildTwoSourceStagingConnectionPlan(parseMetadata(raw));
    console.log(`Validated ${PROFILE}: two read-only source declarations. Live identity, scopes, inventory and portal acceptance remain required. No remote action was performed.`);
    return plan;
  } catch { return invalid(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch { console.error("Two-source staging profile check failed. Use --check --values <operator-metadata.json>; credentials belong only in the secret channel."); process.exitCode = 1; }
}
