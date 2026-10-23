import { isDeepStrictEqual as same } from "node:util";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { WINDOWS_STAGING_SECRET_SLOTS } from "./windows-files-staging-entry-renderer.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const keys = value => Object.keys(value).sort();
const exact = (value, expected) => object(value) && same(keys(value), [...expected].sort());
const without = (value, removed) => Object.fromEntries(Object.entries(value).filter(([key]) => !removed.includes(key)));
const fail = () => { throw Error("windows_staging_secret_clone_inputs_invalid"); };
const budgetFail = () => { throw Error("windows_staging_secret_clone_environment_budget_exceeded"); };
const VERSION_ENVELOPE = ["id", "number", "metadata"];
const MODERN_ENVELOPE = ["id", "number", "startup_time_ms", "annotations", "urls", "source", "created_on", "author_id"];
const MODERN_STATE = ["compatibility_date", "compatibility_flags", "main_module", "exports", "usage_model", "containers", "limits", "modules", "bindings", "env", "assets"];

function bindingMap(bindings) {
  if (!Array.isArray(bindings) || bindings.length > 1000) fail();
  const map = new Map();
  for (const binding of bindings) {
    if (!object(binding) || typeof binding.name !== "string" || !NAME.test(binding.name)
      || typeof binding.type !== "string" || !binding.type || binding.type.length > 128 || map.has(binding.name)) fail();
    map.set(binding.name, binding);
  }
  return map;
}
function envBudget(bindings, additions = 0) {
  const count = bindings.filter(b => ["plain_text", "json", "secret_text", "secret_key"].includes(b.type)).length;
  if (count + additions > 128) budgetFail();
  return count;
}
function modules(modern) {
  if (!Array.isArray(modern.modules) || !modern.modules.length || modern.modules.length > 256
    || typeof modern.main_module !== "string" || !modern.main_module) fail();
  const names = new Set();let size = 0;
  for (const module of modern.modules) {
    if (!exact(module, ["name", "content_type", "content_base64"]) || typeof module.name !== "string" || !module.name
      || module.name.length > 1024 || /\p{C}/u.test(module.name) || names.has(module.name)
      || typeof module.content_type !== "string" || !module.content_type || module.content_type.length > 256
      || typeof module.content_base64 !== "string" || module.content_base64.length > 48 * 1024 * 1024
      || module.content_base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(module.content_base64)) fail();
    const bytes = Buffer.from(module.content_base64, "base64");size += bytes.length;
    if (bytes.toString("base64") !== module.content_base64 || size > 64 * 1024 * 1024) fail();
    names.add(module.name);
  }
  if (!names.has(modern.main_module)) fail();
}
function envelope(value, expectedId, modern) {
  if (!object(value) || value.id !== expectedId) fail();
  const allowed = modern ? [...MODERN_ENVELOPE, ...MODERN_STATE] : [...VERSION_ENVELOPE,"resources"];
  if (Object.keys(value).some(key => !allowed.includes(key)) || !Number.isSafeInteger(value.number) || value.number < 1) fail();
  if (modern) {
    if (!Number.isFinite(value.startup_time_ms) || value.startup_time_ms < 0 || !object(value.annotations)
      || !Array.isArray(value.urls) || value.urls.length > 100 || JSON.stringify(value.urls).length > 65536
      || typeof value.source !== "string" || value.source.length > 128 || typeof value.author_id !== "string" || value.author_id.length > 256
      || typeof value.created_on !== "string" || !Number.isFinite(Date.parse(value.created_on))) fail();
  } else if (!object(value.metadata)) fail();
}
function validatePair(pair, id) {
  if (!exact(pair, ["version","modern"])) fail();
  envelope(pair.version,id,false);envelope(pair.modern,id,true);
  const resources = pair.version.resources;
  if (!exact(resources,["script","script_runtime","bindings"]) || !object(resources.script) || !object(resources.script_runtime)
    || !object(resources.script_runtime.assets) || !object(pair.modern.assets) || !object(pair.modern.assets.config)
    || !exact(resources.script,["etag","handlers","named_handlers","last_deployed_from"])
    || typeof resources.script.etag !== "string" || resources.script.etag.length > 1024
    || typeof resources.script.last_deployed_from !== "string" || resources.script.last_deployed_from.length > 128) fail();
  const bindings = bindingMap(resources.bindings), modernBindings = bindingMap(pair.modern.bindings);
  if (pair.version.number !== pair.modern.number || !same(resources.bindings,pair.modern.bindings) || !same([...bindings.keys()].sort(),[...modernBindings.keys()].sort())
    || !object(pair.modern.env) || !same(keys(pair.modern.env),[...bindings.keys()].sort())) fail();
  for(const key of ["compatibility_date","compatibility_flags","exports","usage_model","containers","limits"])
    if (!same(pair.modern[key],resources.script_runtime[key])) fail();
  for (const [name,binding] of bindings) if (!object(pair.modern.env[name]) || pair.modern.env[name].type !== binding.type) fail();
  modules(pair.modern);
  return bindings;
}

/** Pure operator comparison of supplied responses; no I/O or approval creation.
 * Mutable provider envelope fields are admitted separately and are never
 * mistaken for unchanged module/runtime/resource policy. Unknown resource and
 * binding fields are compared whole rather than normalized away. */
export function compareWindowsStagingSecretClone(input) {
  try {
    if (!exact(input,["app","accountId","workerName","baselineVersionId","candidateVersionId","plannedSecretNames","baseline","candidate"])
      || !Object.hasOwn(WINDOWS_STAGING_SECRET_SLOTS,input.app) || input.accountId !== STAGING_ACCOUNT_ID
      || input.workerName !== STAGING_INVENTORY[input.app].name || !UUID.test(input.baselineVersionId) || !UUID.test(input.candidateVersionId)
      || input.baselineVersionId === input.candidateVersionId || !Array.isArray(input.plannedSecretNames)
      || !same([...input.plannedSecretNames].sort(),[...WINDOWS_STAGING_SECRET_SLOTS[input.app]].sort())) fail();
    const old = validatePair(input.baseline,input.baselineVersionId), candidate = validatePair(input.candidate,input.candidateVersionId);
    if (!same(old.get("ENVIRONMENT"),{name:"ENVIRONMENT",type:"plain_text",text:"staging"})) fail();
    const planned = input.plannedSecretNames;
    if (planned.some(name=>old.has(name))) fail();
    const oldCount = envBudget(input.baseline.version.resources.bindings,planned.length);
    envBudget(input.candidate.version.resources.bindings);
    if (candidate.size !== old.size + planned.length) fail();
    for (const [name,binding] of old) if (!same(binding,candidate.get(name)) || !same(input.baseline.modern.env[name],input.candidate.modern.env[name])) fail();
    for (const name of planned) {
      if (!same(candidate.get(name),{name,type:"secret_text"}) || !same(input.candidate.modern.env[name],{type:"secret_text"})) fail();
    }
    const baselineResource = without(input.baseline.version.resources,["bindings"]), candidateResource = without(input.candidate.version.resources,["bindings"]);
    // Deployment source is envelope provenance; etag and handler metadata remain
    // pinned with all other returned resource fields.
    if (!same(without(baselineResource.script,["last_deployed_from"]),without(candidateResource.script,["last_deployed_from"]))
      || !same(baselineResource.script_runtime,candidateResource.script_runtime)) fail();
    if (!same(without(input.baseline.modern,[...MODERN_ENVELOPE,"bindings","env"]),without(input.candidate.modern,[...MODERN_ENVELOPE,"bindings","env"]))) fail();
    return {schemaVersion:1,status:"supplied_secret_only_candidate_matches",app:input.app,workerName:input.workerName,
      baselineVersionId:input.baselineVersionId,candidateVersionId:input.candidateVersionId,addedSecretCount:planned.length,
      environmentCount:oldCount+planned.length,modulesEqual:true,returnedAssetsMetadataEqual:true,opaqueAssetAssociationVerified:false,
      physicallyVerified:false,freshnessVerified:false,authorized:false,activated:false};
  } catch (error) {
    if (error?.message === "windows_staging_secret_clone_environment_budget_exceeded") budgetFail();
    fail();
  }
}
