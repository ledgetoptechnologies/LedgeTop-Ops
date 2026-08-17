import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateApp, validateCrossApp } from "./staging-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marker = /<([A-Z][A-Z0-9_]*)>/g;
const entries = Object.freeze({
  delivery: Object.freeze({ template: "docs/staging/delivery.wrangler.json.example", output: "apps/client/wrangler.staging.json", production: "apps/client/wrangler.jsonc" }),
  operations: Object.freeze({ template: "docs/staging/operations.wrangler.json.example", output: "apps/operations/wrangler.staging.json", production: "apps/operations/wrangler.jsonc" }),
  "ops-sync": Object.freeze({ template: "docs/staging/ops-sync.wrangler.json.example", output: "apps/ops-sync/wrangler.staging.json", production: "apps/ops-sync/wrangler.jsonc" }),
});
export const REQUIRED_STAGING_CONFIG_VALUES = Object.freeze([
  "PROJECT_ALPHA_CATALOG_STAGING_ACCESS_AUD",
  "PROJECT_ALPHA_PORTAL_STAGING_ACCESS_AUD",
  "DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD",
  "CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN",
  "OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN",
  "STAGING_EMAIL_DOMAIN",
  "STAGING_TRIAGE_EMAIL",
  "STAGING_ACCESS_GROUP_ID",
  "STAGING_ACCESS_GROUP_NAME",
]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const populated = (value) => typeof value === "string" && value.length > 0 && !/[<>]/.test(value);

export function validateValues(values) {
  const errors = [];
  if (!values || typeof values !== "object" || Array.isArray(values)) return ["staging config values must be a JSON object"];
  for (const key of REQUIRED_STAGING_CONFIG_VALUES) if (!populated(values[key])) errors.push(`${key} is missing or contains a placeholder`);
  for (const key of Object.keys(values)) if (!REQUIRED_STAGING_CONFIG_VALUES.includes(key)) errors.push(`unexpected staging config value ${key}`);
  for (const key of ["PROJECT_ALPHA_CATALOG_STAGING_ACCESS_AUD", "PROJECT_ALPHA_PORTAL_STAGING_ACCESS_AUD", "DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD"]) {
    if (populated(values[key]) && !/^[a-f0-9]{64}$/i.test(values[key])) errors.push(`${key} must be a 64-character Access audience`);
  }
  const audiences = [
    values.PROJECT_ALPHA_CATALOG_STAGING_ACCESS_AUD,
    values.PROJECT_ALPHA_PORTAL_STAGING_ACCESS_AUD,
    values.DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD,
  ].filter(populated);
  if (new Set(audiences.map((value) => value.toLowerCase())).size !== audiences.length) errors.push("staging Access audiences must be distinct");
  for (const key of ["CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN", "OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN"]) {
    if (populated(values[key]) && !values[key].startsWith("pk.")) errors.push(`${key} must be a restricted public Mapbox token`);
  }
  if (populated(values.STAGING_EMAIL_DOMAIN) && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(values.STAGING_EMAIL_DOMAIN)) errors.push("STAGING_EMAIL_DOMAIN must be a DNS domain");
  if (populated(values.STAGING_TRIAGE_EMAIL) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.STAGING_TRIAGE_EMAIL)) errors.push("STAGING_TRIAGE_EMAIL must be an email address");
  return errors;
}

function replaceMarkers(value, values) {
  if (typeof value === "string") return value.replace(marker, (_match, name) => values[name] ?? `<${name}>`);
  if (Array.isArray(value)) return value.map((item) => replaceMarkers(item, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceMarkers(item, values)]));
  return value;
}

export function renderConfigs(base, values) {
  const valueErrors = validateValues(values);
  if (valueErrors.length) throw new Error(valueErrors.join("\n"));
  const configs = {};
  for (const [app, entry] of Object.entries(entries)) {
    configs[app] = replaceMarkers(readJson(path.join(base, entry.template)), values);
    const rendered = JSON.stringify(configs[app]);
    const unresolved = [...rendered.matchAll(marker)].map((match) => match[1]);
    if (unresolved.length) throw new Error(`${app} has unresolved values: ${[...new Set(unresolved)].join(", ")}`);
  }
  return configs;
}

export function validateRenderedConfigs(base, configs) {
  const errors = [];
  for (const [app, entry] of Object.entries(entries)) errors.push(...validateApp(app, configs[app], readJson(path.join(base, entry.production))));
  errors.push(...validateCrossApp(configs));
  return errors;
}

export function writeRenderedConfigs(base, configs) {
  const targets = Object.entries(entries).map(([app, entry]) => ({ app, target: path.join(base, entry.output) }));
  for (const { target } of targets) {
    if (fs.existsSync(target)) throw new Error(`${path.relative(base, target)} already exists; preserve or remove it explicitly before rendering a replacement`);
  }
  const temporary = [];
  try {
    for (const { app, target } of targets) {
      const temp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(temp, `${JSON.stringify(configs[app], null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      temporary.push({ temp, target });
    }
    for (const item of temporary) fs.renameSync(item.temp, item.target);
  } finally {
    for (const { temp } of temporary) if (fs.existsSync(temp)) fs.rmSync(temp);
  }
  return targets.map(({ target }) => path.relative(base, target));
}

function parseArguments(argv) {
  let valuesFile = "";
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--values" && argv[index + 1]) valuesFile = argv[++index];
    else if (argv[index] === "--write") write = true;
    else throw new Error(`unknown or incomplete argument ${argv[index]}`);
  }
  if (!valuesFile) throw new Error("usage: node scripts/staging-config-scaffold.mjs --values <local-json> [--write]");
  return { valuesFile, write };
}

export function run(argv = process.argv.slice(2), base = root) {
  const options = parseArguments(argv);
  const valuesPath = path.resolve(base, options.valuesFile);
  const configs = renderConfigs(base, readJson(valuesPath));
  const errors = validateRenderedConfigs(base, configs);
  if (errors.length) throw new Error(`rendered staging configuration is invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  if (!options.write) {
    console.log("Staging configuration values and rendered files are valid. No files or remote resources were changed.");
    return [];
  }
  const written = writeRenderedConfigs(base, configs);
  console.log(`Wrote validated ignored staging configuration:\n${written.map((file) => `- ${file}`).join("\n")}\nNo Cloudflare action was performed.`);
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`Staging configuration scaffold failed: ${error.message}`); process.exitCode = 1; }
}
