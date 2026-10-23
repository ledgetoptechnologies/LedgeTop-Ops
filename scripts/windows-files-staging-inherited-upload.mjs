import { isDeepStrictEqual as same } from "node:util";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { buildWindowsStagingCompositionWithLiveVars } from "./windows-files-staging-live-vars.mjs";

const APPS = ["operations", "delivery"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXPORTS = {
  operations: { SharedProfilePortalIngress: { type: "worker" }, ThumbnailRendererContainer: { type: "durable-object", storage: "sqlite" } },
  delivery: { SharedProfilePortalAuthorityReader: { type: "worker" } },
};
const fail = () => { throw Error("windows_staging_inherited_upload_inputs_invalid"); };
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => object(value) && same(Object.keys(value).sort(), [...keys].sort());
const named = values => [...values].sort((a,b) => a.name.localeCompare(b.name));
const positive = value => Number.isSafeInteger(value) && value > 0;

function assetConfig(assets) {
  const keys = ["not_found_handling", "static_routing", "serve_directly", "raw_run_worker_first", "base_path"];
  if (Object.hasOwn(assets ?? {}, "html_handling")) keys.push("html_handling");
  if (!exact(assets, keys) || !["none", "single-page-application", "404-page"].includes(assets.not_found_handling)
    || typeof assets.serve_directly !== "boolean" || typeof assets.base_path !== "string" || !assets.base_path.startsWith("/")
    || assets.base_path.length > 1024 || /[\p{C}?#]/u.test(assets.base_path)
    || Object.hasOwn(assets, "html_handling") && !["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"].includes(assets.html_handling)
    || !Array.isArray(assets.raw_run_worker_first) || assets.raw_run_worker_first.length > 1000
    || assets.raw_run_worker_first.some(p => typeof p !== "string" || p.length > 1024 || !/^(?:!\/|\/)/u.test(p) || /\p{C}/u.test(p))) fail();
  const user = assets.raw_run_worker_first.filter(p => !p.startsWith("!"));
  const asset = assets.raw_run_worker_first.filter(p => p.startsWith("!")).map(p => p.slice(1));
  // Wrangler emits both keys; API reads can omit an empty array. Normalize only
  // that lossless omission for validation, never the raw post-upload comparison.
  const routing = { asset_worker: asset, user_worker: user };
  if (!user.length) fail();
  if (!object(assets.static_routing) || Object.keys(assets.static_routing).some(k => !["asset_worker","user_worker"].includes(k))
    || Object.values(assets.static_routing).some(v => !Array.isArray(v))
    || !same(routing, { asset_worker: assets.static_routing.asset_worker ?? [], user_worker: assets.static_routing.user_worker ?? [] })) fail();
  // The version API rejects deprecated serve_directly together with explicit
  // run_worker_first (10021). Omit it only from request serialization; the
  // complete observed assets object still has to match inactive readback.
  const { static_routing, raw_run_worker_first, serve_directly, ...config } = assets;
  return { ...structuredClone(config), run_worker_first: [...raw_run_worker_first] };
}

function runtimeMetadata(app, runtime, source) {
  const keys = ["assets", "compatibility_date", "compatibility_flags", "exports", "usage_model", app === "operations" ? "containers" : "limits"];
  if (!exact(runtime, keys) || runtime.usage_model !== "standard" || !same(runtime.exports, EXPORTS[app])) fail();
  // Only the current live declarations are supported: no tombstones, transfer,
  // rename, newly created classes, storage changes or per-entrypoint policy.
  for (const [name, declaration] of Object.entries(source.exports ?? {})) if (!same(declaration, EXPORTS[app][name])) fail();
  const metadata = { exports: structuredClone(runtime.exports), usage_model: runtime.usage_model,
    assets: { config: assetConfig(runtime.assets) }, keep_assets: true, keep_bindings: [] };
  if (app === "operations") {
    if (!same(runtime.containers, [{ class_name: "ThumbnailRendererContainer" }])
      || !Array.isArray(source.containers) || source.containers.length !== 1
      || source.containers[0].class_name !== "ThumbnailRendererContainer"
      || !same(source.durable_objects?.bindings, [{ name: "THUMBNAIL_RENDERER", class_name: "ThumbnailRendererContainer" }])) fail();
    metadata.containers = structuredClone(runtime.containers);
  } else {
    if (!exact(runtime.limits, ["cpu_ms", "subrequests"]) || !positive(runtime.limits.cpu_ms) || !positive(runtime.limits.subrequests)
      || source.containers !== undefined || source.durable_objects !== undefined) fail();
    metadata.limits = structuredClone(runtime.limits);
  }
  return metadata;
}

function observedBindings(app, bindings, observed) {
  const inventory = STAGING_INVENTORY[app];
  const objects = bindings.filter(b => b.type === "durable_object_namespace");
  if (app === "operations") {
    const binding = objects[0];
    if (objects.length !== 1 || !exact(binding, ["name","type","class_name","namespace_id"])
      || binding.name !== "THUMBNAIL_RENDERER" || binding.class_name !== "ThumbnailRendererContainer"
      || typeof binding.namespace_id !== "string" || !/^[a-f0-9]{32}$/u.test(binding.namespace_id)) fail();
  } else if (objects.length) fail();
  for (const [type, expected, field, expectedField] of [["d1", inventory.d1_databases, "id", "database_id"], ["r2_bucket", inventory.r2_buckets, "bucket_name", "bucket_name"]]) {
    const actual = bindings.filter(b => b.type === type);
    if (actual.length !== expected.length || expected.some(b => actual.find(a => a.name === b.binding)?.[field] !== b[expectedField])) fail();
  }
  const services = bindings.filter(b => b.type === "service");
  if (!same(named(services.map(b => ({ name: b.name, service: b.service, entrypoint: b.entrypoint }))),
    named(observed.services.map(b => ({ name: b.binding, service: b.workerName, entrypoint: b.entrypoint }))))
    || services.some(b => ![undefined,"","production"].includes(b.environment))) fail();
  const secrets = bindings.filter(b => b.type === "secret_text");
  if (secrets.some(b => !exact(b, ["name", "type"])) || !same(secrets.map(b => b.name).sort(), [...observed.secretSlots].sort())) fail();
  if (!same(bindings.filter(b => b.type === "assets"), [{ name: "ASSETS", type: "assets" }])) fail();
}

/** Offline preparation ONLY. snapshotRefs are paired envelopes containing
 * accountId, workerName, latestUploadedVersionId, activeDeployment:{versions}.
 * These are caller-supplied consistency checks, never admission or proof that
 * an inheritance race cannot occur. Re-read just before actual upload. */
export function prepareWindowsStagingInheritedUpload(input) {
  try {
    const composed = buildWindowsStagingCompositionWithLiveVars(input);
    const uploads = {}, promotions = {}, workers = [];
    for (const app of APPS) {
      const source = input.sources[app], config = composed.configs[app], detail = input.versionDetails[app].detail;
      const observed = input.preflight.workers.find(w => w.app === app), refs = input.snapshotRefs?.[app];
      const baselineFlags = detail.resources.script_runtime.compatibility_flags;
      const expectedFlags = input.profile.enabled && app === "operations" && !baselineFlags.includes("enable_request_signal")
        ? [...baselineFlags, "enable_request_signal"] : baselineFlags;
      if (!exact(refs, ["accountId", "workerName", "latestUploadedVersionId", "activeDeployment"])
        || refs.accountId !== STAGING_ACCOUNT_ID || refs.workerName !== source.name || refs.latestUploadedVersionId !== detail.id
        || !exact(refs.activeDeployment, ["versions"]) || !same(refs.activeDeployment.versions, [{ version_id: detail.id, percentage: 100 }])
        || source.migrations !== undefined || source.site !== undefined || source.unsafe !== undefined
        || !same(config.compatibility_flags, expectedFlags)
        || config.compatibility_date !== detail.resources.script_runtime.compatibility_date) fail();
      observedBindings(app, detail.resources.bindings, observed);
      const metadata = runtimeMetadata(app, detail.resources.script_runtime, source);
      uploads[app] = { name: config.name, account_id: config.account_id, main: config.main,
        compatibility_date: config.compatibility_date, compatibility_flags: [...config.compatibility_flags], vars: structuredClone(config.vars),
        unsafe: { bindings: detail.resources.bindings.filter(b => b.type !== "plain_text").map(b => ({ name: b.name, type: "inherit" })), metadata } };
      promotions[app] = { name: config.name, account_id: config.account_id };
      workers.push({ app, workerName: config.name, baselineVersionId: detail.id,
        plainTextCount: Object.keys(config.vars).length, inheritedBindingCount: uploads[app].unsafe.bindings.length });
    }
    return { uploads, promotions, entries: composed.entries, receipt: { schemaVersion: 1, status: "offline_inactive_upload_preparation_only",
      workers, activated: false, physicallyVerified: false, uploadAuthorized: false, promotionAuthorized: false,
      fullInactiveAssetsAndResourcesComparisonRequired: true, latestUploadedRecheckRequired: true,
      dedicatedWindowsSecretProvisioningVerified: false } };
  } catch { fail(); }
}

/** Compare actual inactive-version resources before a separate activation gate.
 * This never approves promotion, verifies code, or proves the asset association
 * itself. The runtime assets routing object must be byte-for-byte equivalent. */
export function compareWindowsStagingInheritedCandidate(input, candidateVersionDetails) {
  try {
    const preparation = prepareWindowsStagingInheritedUpload(input);
    for (const app of APPS) {
      const baseline = input.versionDetails[app].detail, candidate = candidateVersionDetails?.[app];
      const expectedRuntime = { ...baseline.resources.script_runtime,
        compatibility_flags: preparation.uploads[app].compatibility_flags };
      if (candidate?.accountId !== STAGING_ACCOUNT_ID || candidate.workerName !== input.sources[app].name
        || typeof candidate.detail?.id !== "string" || !UUID.test(candidate.detail.id) || candidate.detail.id === baseline.id
        || !same(candidate.detail.resources?.script_runtime, expectedRuntime)) fail();
      const bindings = candidate.detail.resources?.bindings;
      if (!Array.isArray(bindings) || !same(named(bindings.filter(b => b.type !== "plain_text")), named(baseline.resources.bindings.filter(b => b.type !== "plain_text")))) fail();
      const expectedVars = Object.entries(preparation.uploads[app].vars).map(([name,text]) => ({ name,type:"plain_text",text }));
      if (!same(named(bindings.filter(b => b.type === "plain_text")), named(expectedVars))) fail();
    }
    return { schemaVersion: 1, status: "supplied_inactive_resources_match", assetsRoutingCompared: true,
      assetAssociationVerified: false, codeVerified: false, promotionAuthorized: false, activated: false };
  } catch { fail(); }
}
