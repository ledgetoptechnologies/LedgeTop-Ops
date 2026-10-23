import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { WINDOWS_STAGING_SECRET_SLOTS } from "./windows-files-staging-entry-renderer.mjs";

const RETIRED = "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED";
const LIMIT = 128;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Offline early gate for one staging Worker. Supply names/types only, never
 * values. This neither fetches current settings nor authorizes a cloud change.
 * Count the planned Windows secrets before adding any of them remotely. */
export function inspectWindowsStagingOpsBindingBudget(input) {
  const reject = code => { throw new Error(code); };
  if (!exact(input, ["accountId", "workerName", "bindings"])
    || input.accountId !== STAGING_ACCOUNT_ID || input.workerName !== STAGING_INVENTORY.operations.name
    || !Array.isArray(input.bindings) || input.bindings.length > 1000)
    reject("windows_staging_ops_binding_budget_input_invalid");
  const bindings = new Map();
  for (const item of input.bindings) {
    if (!exact(item, ["name", "type"]) || typeof item.name !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(item.name)
      || typeof item.type !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(item.type)
      || bindings.has(item.name)) reject("windows_staging_ops_binding_budget_input_invalid");
    // This receipt qualifies the observed text/secret deployment shape only.
    // Do not silently omit a newly introduced JSON variable from the limit.
    if (item.type === "json") reject("windows_staging_ops_binding_budget_json_unreviewed");
    bindings.set(item.name, item.type);
  }
  if (bindings.has(RETIRED)) reject("windows_staging_ops_membership_binding_not_retired");
  const plannedSecretNames = WINDOWS_STAGING_SECRET_SLOTS.operations;
  if (plannedSecretNames.some(name => bindings.has(name) && bindings.get(name) !== "secret_text"))
    reject("windows_staging_ops_binding_budget_secret_type_invalid");
  const plainText = [...bindings.values()].filter(type => type === "plain_text").length;
  const secretText = [...bindings.values()].filter(type => type === "secret_text").length;
  const additionalSecretNames = plannedSecretNames.filter(name => !bindings.has(name));
  const plannedTotal = plainText + secretText + additionalSecretNames.length;
  if (plannedTotal > LIMIT) reject("windows_staging_ops_text_secret_budget_exceeded");
  return Object.freeze({ schemaVersion: 1, accountId: input.accountId, workerName: input.workerName,
    limit: LIMIT, observedPlainText: plainText, observedSecretText: secretText,
    additionalSecretNames: Object.freeze([...additionalSecretNames]), plannedTotal,
    observedOnly: true, cloudChanged: false });
}
