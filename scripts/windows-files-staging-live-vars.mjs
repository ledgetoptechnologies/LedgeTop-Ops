import { isDeepStrictEqual } from "node:util";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { buildWindowsStagingComposition, WINDOWS_STAGING_SECRET_SLOTS } from "./windows-files-staging-composition.mjs";

const APPS = ["operations", "delivery"];
const NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TYPES = new Set(["assets", "d1", "durable_object_namespace", "plain_text", "queue", "r2_bucket", "secret_text", "send_email", "service", "stream", "workflow", "ratelimit"]);
const SLOTS = new Set(Object.values(WINDOWS_STAGING_SECRET_SLOTS).flat());
const reject = () => { throw Error("windows_staging_live_vars_inputs_invalid"); };

/** Pure transform of supplied observations. versionDetails pairs are envelopes
 * {accountId, workerName, detail}; detail is the actual version-detail response.
 * These labels establish snapshot consistency, not physical ownership, freshness
 * or authorization. No I/O, credential reads, network calls or activation.
 *
 * ONLY plain-text variables are preserved. Routes, cron, assets and other
 * binding resources still need independent preservation review before deployment.
 * Returned configs contain values and must be handled privately; receipts/errors
 * deliberately contain no values or per-variable hashes. */
export function preserveWindowsStagingLiveVars({ sources, preflight, versionDetails }) {
  try {
    if (preflight?.status !== "read_only_observed" || preflight.accountId !== STAGING_ACCOUNT_ID
      || preflight.versionBindingsMatchedInventory !== true || !Array.isArray(preflight.workers)
      || preflight.workers.length !== 2 || new Set(preflight.workers.map(w => w.app)).size !== 2) reject();
    const preserved = {}, workers = [];
    for (const app of APPS) {
      const source = sources?.[app], observation = preflight.workers.find(w => w.app === app);
      const envelope = versionDetails?.[app], detail = envelope?.detail;
      if (!source || source.account_id !== STAGING_ACCOUNT_ID || source.name !== STAGING_INVENTORY[app].name
        || observation?.workerName !== source.name || !UUID.test(observation.versionId)
        || envelope?.accountId !== STAGING_ACCOUNT_ID || envelope.workerName !== source.name
        || detail?.id !== observation.versionId) reject();
      const runtime = detail.resources?.script_runtime, bindings = detail.resources?.bindings;
      if (!runtime || typeof source.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(source.compatibility_date)
        || runtime.compatibility_date !== source.compatibility_date
        || !Array.isArray(runtime.compatibility_flags) || runtime.compatibility_flags.length > 100
        || runtime.compatibility_flags.some(f => typeof f !== "string" || !/^[a-z0-9_]{1,128}$/u.test(f))
        || new Set(runtime.compatibility_flags).size !== runtime.compatibility_flags.length
        || !isDeepStrictEqual(runtime.compatibility_flags, source.compatibility_flags ?? [])) reject();
      if (!Array.isArray(bindings) || bindings.length > 1000) reject();
      const names = new Set(), vars = Object.create(null);
      let bytes = 0;
      for (const binding of bindings) {
        if (!binding || typeof binding.name !== "string" || !NAME.test(binding.name)
          || names.has(binding.name) || !TYPES.has(binding.type)) reject();
        names.add(binding.name);
        if (binding.type === "plain_text") {
          if (SLOTS.has(binding.name) || typeof binding.text !== "string" || Buffer.byteLength(binding.text, "utf8") > 32768) reject();
          bytes += Buffer.byteLength(binding.text, "utf8");
          if (bytes > 1024 * 1024) reject();
          vars[binding.name] = binding.text;
        }
      }
      if (vars.ENVIRONMENT !== "staging" || [...SLOTS].some(slot => Object.hasOwn(source.vars ?? {}, slot))) reject();
      preserved[app] = structuredClone(source);
      preserved[app].vars = { ...vars };
      workers.push({ app, workerName: source.name, versionId: detail.id, plainTextCount: Object.keys(vars).length });
    }
    return { sources: preserved, receipt: { schemaVersion: 1, status: "supplied_live_variables_preserved", workers,
      variablesOnly: true, physicallyVerified: false, freshnessVerified: false, activated: false } };
  } catch { reject(); }
}

/** Optional wrapper: the original constructor and all of its admission checks
 * remain unchanged. Enabled composition may explicitly override its documented
 * Windows flags; disabled preparation preserves the captured values exactly. */
export function buildWindowsStagingCompositionWithLiveVars({ profile, sources, preflight, versionDetails }) {
  const preserved = preserveWindowsStagingLiveVars({ sources, preflight, versionDetails });
  try {
    const result = buildWindowsStagingComposition({ profile, sources: preserved.sources, preflight });
    return { ...result, receipt: { ...result.receipt, liveVariables: preserved.receipt } };
  } catch { reject(); }
}
