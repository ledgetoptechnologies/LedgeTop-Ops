import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { validateApp } from "./staging-preflight.mjs";
import { STAGING_HOSTS } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RECIPIENT_ENROLLMENT_CONFIGS = Object.freeze({
  delivery: Object.freeze({
    source: "apps/client/wrangler.staging.json",
    production: "apps/client/wrangler.jsonc",
    output: "apps/client/wrangler.staging.recipient-enrollment.json",
  }),
  operations: Object.freeze({
    source: "apps/operations/wrangler.staging.json",
    production: "apps/operations/wrangler.jsonc",
    output: "apps/operations/wrangler.staging.recipient-enrollment.json",
  }),
});

export const RECIPIENT_ENROLLMENT_ACTIVATION_VALUES = Object.freeze({
  delivery: Object.freeze({
    CLIENT_PORTAL_ENABLED: "true",
    CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED: "true",
    CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED: "true",
    CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED: "true",
    CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED: "true",
    CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true",
  }),
  operations: Object.freeze({
    CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED: "true",
    CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ENABLED: "true",
    CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ORIGIN: `https://${STAGING_HOSTS.operations}`,
    CLIENT_PORTAL_AUTHORITY_V2_OUTBOX_ENABLED: "true",
    CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true",
  }),
});

const INACTIVE_WORKSPACE_FLAGS = Object.freeze({
  delivery: Object.freeze([
    "CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED",
    "CLIENT_AUTHORITY_WORKSPACE_BINDING_STATUS_ENABLED",
    "CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED",
    "CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED",
  ]),
  operations: Object.freeze([
    "CLIENT_PORTAL_WORKSPACE_BINDING_ADMIN_ENABLED",
    "CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED",
    "VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED",
  ]),
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const clone = (value) => structuredClone(value);

function validateSourcePair(sources, productionConfigs) {
  const errors = [];
  for (const app of Object.keys(RECIPIENT_ENROLLMENT_CONFIGS)) {
    errors.push(...validateApp(app, sources?.[app], productionConfigs?.[app]).map((error) => `${app}: ${error}`));
  }
  const bridge = sources?.delivery?.services?.find(({ binding }) => binding === "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE");
  if (bridge?.service !== sources?.operations?.name || bridge?.entrypoint !== "ClientPortalRecipientEnrollmentBridge") {
    errors.push("delivery recipient enrollment bridge must target the exact Operations staging Worker and private named entrypoint");
  }
  const authority = sources?.operations?.services?.find(({ binding }) => binding === "VERIFIED_RECIPIENT_DELIVERY_AUTHORITY");
  if (authority?.service !== sources?.delivery?.name || authority?.entrypoint !== "VerifiedRecipientDeliveryAuthorityIngress") {
    errors.push("operations verified recipient authority must target the exact Client staging Worker and private named entrypoint");
  }
  const audiences = [sources?.delivery?.vars?.POLICY_AUD, sources?.delivery?.vars?.CLIENT_ACCESS_AUD,
    sources?.operations?.vars?.OPERATIONS_AUD];
  if (new Set(audiences).size !== audiences.length) errors.push("recipient enrollment source configs must keep Delivery, Client, and Operations staging audiences distinct");
  if (Object.hasOwn(sources?.delivery?.vars ?? {}, "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET")) {
    errors.push("recipient enrollment CSRF secret must be supplied only through the staging secret manifest");
  }
  return errors;
}

export function buildRecipientEnrollmentConfigs(sources, productionConfigs) {
  const errors = validateSourcePair(sources, productionConfigs);
  if (errors.length) throw new Error(errors.join("\n"));
  return Object.fromEntries(Object.keys(RECIPIENT_ENROLLMENT_CONFIGS).map((app) => {
    const candidate = clone(sources[app]);
    Object.assign(candidate.vars, RECIPIENT_ENROLLMENT_ACTIVATION_VALUES[app]);
    return [app, candidate];
  }));
}

export function validateRecipientEnrollmentConfigs(sources, candidates, productionConfigs) {
  const errors = validateSourcePair(sources, productionConfigs);
  for (const app of Object.keys(RECIPIENT_ENROLLMENT_CONFIGS)) {
    const source = sources?.[app];
    const candidate = candidates?.[app];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      errors.push(`${app} recipient enrollment candidate must be a JSON object`);
      continue;
    }
    const expected = clone(source);
    Object.assign(expected.vars, RECIPIENT_ENROLLMENT_ACTIVATION_VALUES[app]);
    if (!isDeepStrictEqual(candidate, expected)) {
      errors.push(`${app} recipient enrollment candidate drifted outside the explicit reviewed activation window`);
    }
    for (const [flag, value] of Object.entries(RECIPIENT_ENROLLMENT_ACTIVATION_VALUES[app])) {
      if (candidate.vars?.[flag] !== value) errors.push(`${app} recipient enrollment candidate must set ${flag}=${value}`);
    }
    for (const flag of INACTIVE_WORKSPACE_FLAGS[app]) {
      if (candidate.vars?.[flag] !== "false") errors.push(`${app} recipient enrollment candidate must keep ${flag}=false unless a separate joined fixture requires it`);
    }
    if (app === "operations" && candidate.vars?.CLIENT_PORTAL_WORKSPACE_BINDING_ADMIN_ORIGIN !== "") {
      errors.push("operations recipient enrollment candidate must keep the inactive workspace admin origin empty");
    }
    if (Object.hasOwn(candidate.vars ?? {}, "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET")) {
      errors.push("recipient enrollment CSRF secret must not be written to a Wrangler vars block");
    }
  }
  return errors;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: node scripts/staging-recipient-enrollment-config.mjs --write|--check");
  }
  return argv[0];
}

function loadInputs(base) {
  const sources = {}, productionConfigs = {};
  for (const [app, files] of Object.entries(RECIPIENT_ENROLLMENT_CONFIGS)) {
    const sourcePath = path.join(base, files.source);
    const productionPath = path.join(base, files.production);
    if (!fs.existsSync(sourcePath)) throw new Error(`${files.source} is missing; render and validate default-off staging configs first`);
    sources[app] = readJson(sourcePath);
    productionConfigs[app] = readJson(productionPath);
  }
  return { sources, productionConfigs };
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parseArguments(argv);
  const { sources, productionConfigs } = loadInputs(base);
  const expected = buildRecipientEnrollmentConfigs(sources, productionConfigs);
  const existing = {};
  for (const [app, files] of Object.entries(RECIPIENT_ENROLLMENT_CONFIGS)) {
    const outputPath = path.join(base, files.output);
    if (fs.existsSync(outputPath)) existing[app] = readJson(outputPath);
    else existing[app] = expected[app];
  }
  const errors = validateRecipientEnrollmentConfigs(sources, existing, productionConfigs);
  if (errors.length) throw new Error(`recipient enrollment candidate config is invalid or stale:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    const missing = Object.entries(RECIPIENT_ENROLLMENT_CONFIGS).filter(([, files]) => !fs.existsSync(path.join(base, files.output)));
    if (missing.length) throw new Error(`${missing.map(([, files]) => files.output).join(", ")} missing; generate with --write`);
    console.log("Validated ignored recipient enrollment candidate configs. No remote action was performed.");
    return Object.values(RECIPIENT_ENROLLMENT_CONFIGS).map(({ output }) => output);
  }

  const temporaries = [];
  try {
    for (const [app, files] of Object.entries(RECIPIENT_ENROLLMENT_CONFIGS)) {
      const outputPath = path.join(base, files.output);
      if (fs.existsSync(outputPath)) continue;
      const temporary = `${outputPath}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(expected[app], null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      temporaries.push({ temporary, outputPath });
    }
    for (const { temporary, outputPath } of temporaries) fs.renameSync(temporary, outputPath);
  } finally {
    for (const { temporary } of temporaries) if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  console.log("Wrote ignored recipient enrollment candidate configs from the validated default-off staging configs. No remote action was performed.");
  return Object.values(RECIPIENT_ENROLLMENT_CONFIGS).map(({ output }) => output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`Recipient enrollment staging config failed: ${error.message}`); process.exitCode = 1; }
}
