/**
 * Offline, configuration-only builder for the staging native inquiry pilot.
 * It never contacts Cloudflare, creates an upload session, deploys a version,
 * grants recipient authority, migrates D1, or sends notifications.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonical, hash, need } from './production-deploy.mjs';
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from './staging-requirements.mjs';

const ARTIFACT_ROOT = 'C:/Users/fstor/.codex/artifacts/production-ops-retained-resume-execution-20261031';
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const CONTRACT = 'staging-native-inquiry-pilot-config-only-v2';
const BASE_CONTROLS = Object.freeze({
  path: `${ARTIFACT_ROOT}/owner-review-v5-activation-20261031/after-controls.private.json`,
  sha256: '3d05ff11937a3dd0829cab5f3649ae3b2366ed0f5772de402fe858dc7a5a8e21',
});
// The Ops step must compare against the exact historical baseline used to
// compile the original Client-first held plan. Current controls remain fresh.
const CLIENT_PILOT_BASELINE = Object.freeze({
  path: `${ARTIFACT_ROOT}/native-inquiry-pilot-v2-baseline-controls-20261031/controls.private.json`,
  sha256: 'c82f325e6c068c434f292597f2e4b8fed154ec01c9c026a6bb1f1f821562e1d6',
});
const CLIENT_PILOT_HELD_PLAN_SHA256 = 'd511657e9c053625096056dbbaa05f8cd8fe67903777e3ce93fa6f2ffa3323f9';
const CLIENT_PILOT_ACTIVATION_CONTROLS = Object.freeze({
  path: `${ARTIFACT_ROOT}/native-inquiry-client-v2-activation-20261031/after-controls.private.json`,
  sha256: '05cc774472eb335606e54c411a8f69be0ddb88d19c96c2a096406393e3d4eb51',
});
const CLIENT_PILOT_ACTIVATION_RECEIPT = Object.freeze({
  path: `${ARTIFACT_ROOT}/native-inquiry-client-v2-activation-20261031/client-pilot-readback-v2.private.json`,
  sha256: '20996902522e012190645cb75793b2b7df14df9b81deb10c0360ae970cd31d51',
});
const BASE_PLANS = Object.freeze({
  operations: Object.freeze({
    path: `${ARTIFACT_ROOT}/recipient-owner-review-backend-release-plan-20261031/successor.held.json`,
    sha256: '6eff3d24ac2c179aeb0de175b86d583824e42df4b7ec4566d111755b3e02f9ee',
    baseVersionId: 'e299b7af-f9ed-424b-ae8f-3fdff4f0614e',
    schemaVersion: 5, contract: 'staging-backend-only-owner-review-profile-v5',
    sourceCommit: '4ee6cbe84265d07e2998b795f2a130763e95d4db',
  }),
  client: Object.freeze({
    path: `${ARTIFACT_ROOT}/recipient-client-ui-after-ops-g3-20261031/client/successor.held.json`,
    sha256: '2919a542dd9955e84b97874c1fa3ec7229dd4f93ec2b5d8067baf40c122d1b82',
    baseVersionId: 'b1f9053b-e1b9-4435-8bc0-49d03b393fab',
    schemaVersion: 4, contract: 'staging-backend-only-current-profile-v4',
    sourceCommit: 'b22abeccd1889ed2f745db98c6123bafa5820b97',
  }),
});
const CURRENT = Object.freeze({
  operations: Object.freeze({ workerName: STAGING_INVENTORY.operations.name,
    activeVersionId: '49d03b5c-b104-4f00-974c-334f2ea576f1', latestVersionId: '49d03b5c-b104-4f00-974c-334f2ea576f1' }),
  client: Object.freeze({ workerName: STAGING_INVENTORY.delivery.name,
    activeVersionId: '2e8dd07c-3ccc-47ea-91ce-6e896b42313d', latestVersionId: '2e8dd07c-3ccc-47ea-91ce-6e896b42313d' }),
  sync: Object.freeze({ workerName: STAGING_INVENTORY['ops-sync'].name,
    activeVersionId: '470134b4-ef95-4702-98f3-110e4f4cbbb0', latestVersionId: '470134b4-ef95-4702-98f3-110e4f4cbbb0' }),
});
const SOURCE_COMMITS = Object.freeze({ operations: '4ee6cbe84265d07e2998b795f2a130763e95d4db',
  client: 'b22abeccd1889ed2f745db98c6123bafa5820b97' });
const GATES = Object.freeze({
  client: Object.freeze(['CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED', 'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED']),
  operations: Object.freeze(['OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED', 'CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED']),
});
const CLIENT_RECEIPT_PURPOSE = 'staging-native-inquiry-pilot-client-configuration-readback-v2';
const CLIENT_RECEIPT_KEYS = Object.freeze(['schemaVersion','purpose','accountId','workerName','baselineVersionId',
  'candidateVersionId','deploymentId','sourceCommit','planSHA256','baselineControlsSHA256','controlsSHA256','observedAt','readbackVerified',
  'exactClientDeltaVerified','activeRuntimeUnchanged','otherControlsUnchanged','schemaUnchanged',
  'resourceWrites','applicationRowsRead']);
const MAX_CONTROLS_AGE_MS = 30 * 60_000;
const clone = value => structuredClone(value);
const equal = (a, b) => canonical(a) === canonical(b);
const serializedPlanBytes = plan => Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8');
export const hashStagingNativeInquiryPilotV2PlanFile = plan => hash(serializedPlanBytes(plan));
const gateSet = new Set([...GATES.client, ...GATES.operations]);
const fail = (condition, message) => need(condition, `Native inquiry pilot plan: ${message}`);

function keysAre(value, expected) {
  return !!value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function noSecretValues(value, parent = null) {
  if (Array.isArray(value)) { for (const item of value) noSecretValues(item, parent); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const allowedPilotText = key === 'text' && child === 'true' && value.type === 'plain_text';
    fail(!['secret','token','jwt','opaqueToken','text','value','secretValue','credential'].includes(key)
      || allowedPilotText, 'raw credential or binding value is present');
    noSecretValues(child, value);
  }
}

function validateFreshControls(controls, now, { allowClientPilotVersion = false } = {}) {
  fail(controls && controls.schemaVersion === 1
    && controls.purpose === 'staging-v4-current-controls-and-full-schema-readonly-v1'
    && controls.accountId === STAGING_ACCOUNT_ID && controls.environment === 'staging'
    && controls.resourceWrites === 0 && controls.applicationRowsRead === 0,
  'controls capture is outside the fixed staging account or not read-only');
  const observedAt = Date.parse(controls.observedAt);
  fail(Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= MAX_CONTROLS_AGE_MS,
    'controls capture is stale or from the future');
  const workers = controls.workers;
  fail(workers && Object.keys(workers).sort().join(',') === 'client,operations,sync',
    'controls worker set differs');
  for (const [app, target] of Object.entries(CURRENT)) {
    const row = workers[app];
    const clientPilot = app === 'client' && allowClientPilotVersion;
    const versionOkay = clientPilot
      ? UUID.test(row.activeVersionId ?? '') && row.latestVersionId === row.activeVersionId
      : row?.activeVersionId === target.activeVersionId && row.latestVersionId === target.latestVersionId;
    const deploymentOkay = Array.isArray(row?.deployment?.versions) && row.deployment.versions.length === 1
      && row.deployment.versions[0].version_id === row.activeVersionId && row.deployment.versions[0].percentage === 100;
    fail(row?.workerName === target.workerName && versionOkay && deploymentOkay,
      `${app} is not on the pinned active/latest baseline (pilot=${clientPilot}, version=${versionOkay}, deployment=${deploymentOkay})`);
  }
  fail(controls.schema && controls.schema.OPS_DB?.id === STAGING_INVENTORY.operations.d1_databases[0].database_id
    && controls.schema.DELIVERY_DB?.id === STAGING_INVENTORY.delivery.d1_databases[0].database_id,
  'fixed staging D1 schema inventory is missing');
  return controls;
}

function assertAllFlagsHeldOff(worker, app) {
  const flags = worker.selectedFlags;
  fail(flags && Object.getPrototypeOf(flags) === Object.prototype, `${app} selected flag snapshot is malformed`);
  for (const name of gateSet) {
    const value = flags[name];
    fail(value === undefined || value === null || value === 'false', `${app} capability gate ${name} is not off`);
  }
  for (const [name, value] of Object.entries(flags)) {
    if (name === 'CLIENT_PORTAL_REQUEST_V2_ENABLED' || name === 'CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED')
      fail(value === undefined || value === null || value === 'false', `${name} must remain off`);
  }
}

function moduleHash(module) {
  fail(module && typeof module.content_base64 === 'string' && module.content_base64.length <= 96 * 1024 * 1024,
    'held source module is malformed or too large');
  const bytes = Buffer.from(module.content_base64, 'base64');
  fail(bytes.toString('base64') === module.content_base64, 'held source module encoding is not canonical');
  return { bytes, sha256: hash(bytes) };
}

function expectedMain(app) { return app === 'operations' ? 'staging-native-authority-entrypoint.js' : 'index.js'; }

function validateBasePlan(basePlan, app, controls) {
  const pin = BASE_PLANS[app], worker = controls.workers[app];
  fail(basePlan?.schemaVersion === pin.schemaVersion && basePlan.contract === pin.contract
    && basePlan.application === app && basePlan.accountId === STAGING_ACCOUNT_ID
    && basePlan.selectedWorker === CURRENT[app].workerName && basePlan.selectedActiveVersionId === pin.baseVersionId
    && basePlan.selectedLatestVersionId === pin.baseVersionId && basePlan.sourceCommit === pin.sourceCommit
    && basePlan.executionAllowed === false && basePlan.held === true && basePlan.offlineOnly === true
    && basePlan.deploymentEnabled === false && basePlan.noMigrationConfig === true && basePlan.noOpsSyncUpdate === true,
  `${app} held base plan identity or safety posture differs`);
  fail(basePlan.databaseSchemaSHA256 === hash(canonical(controls.schema)), `${app} D1 schema differs from held base plan`);
  fail(basePlan.versionCreateTemplate?.account_id === STAGING_ACCOUNT_ID
    && basePlan.versionCreateTemplate.deploy === false && !Object.hasOwn(basePlan.versionCreateTemplate, 'assets')
    && !Object.hasOwn(basePlan.versionCreateTemplate, 'migrations'), `${app} base template contains deployment, asset JWT, or migration input`);
  const template = basePlan.versionCreateTemplate;
  const mainName = expectedMain(app), main = template.modules?.find(row => row.name === mainName);
  const sourceMapName = `${mainName}.map`, sourceMapModule = template.modules?.find(row => row.name === sourceMapName);
  const mainBytes = main && moduleHash(main);
  const sourceMapBytes = sourceMapModule && moduleHash(sourceMapModule);
  const artifact = basePlan.artifact;
  fail(template.main_module === mainName && mainBytes && artifact?.sourceCommit === pin.sourceCommit
    && artifact.main?.sha256 === mainBytes.sha256 && artifact.main.size === mainBytes.bytes.length
    && artifact.sourceMap?.sha256 && SHA.test(artifact.sourceMap.sha256)
    && sourceMapBytes?.sha256 === artifact.sourceMap.sha256
    && artifact.sourceMap.size === sourceMapBytes.bytes.length,
  `${app} main/source-map pins differ from the qualified base artifact`);
  fail(worker.modern.main_module === mainName && worker.modern.modules?.length === 1
    && worker.modern.modules[0].name === mainName && worker.modern.modules[0].sha256 === mainBytes.sha256
    && worker.modern.modules[0].bytes === mainBytes.bytes.length,
  `${app} installed executable main differs from qualified b22 build`);
  const expected = basePlan.expectedUnchangedResources, actual = worker.version?.resources;
  fail(expected && actual && equal(expected.script_runtime, actual.script_runtime)
    && equal(expected.bindings, actual.bindings)
    && equal(expected.script.handlers, actual.script.handlers)
    && equal(expected.script.named_handlers, actual.script.named_handlers)
    && expected.script.last_deployed_from === actual.script.last_deployed_from,
  `${app} installed runtime, exports, limits, bindings or handlers differ from qualified base plan`);
  fail(equal(basePlan.expectedUnchangedSettings, worker.settings)
    && equal(basePlan.expectedUnchangedSchedules, worker.schedules.schedules)
    && equal(basePlan.expectedUnchangedExports, worker.modern.exports)
    && equal(basePlan.expectedUnchangedModernAssets, worker.modern.assets)
    && equal(basePlan.expectedUnchangedSelectedFlags, worker.selectedFlags),
  `${app} installed settings, schedules, exports, assets or flags differ from qualified base plan`);
  const rows = template.bindings;
  const expectedBindings = actual.bindings.filter(row => !(row.name === 'ASSETS' && row.type === 'assets'));
  fail(Array.isArray(rows) && rows.length === expectedBindings.length
    && rows.every(row => Object.keys(row).sort().join(',') === 'name,type,version_id'
      && row.type === 'inherit' && row.version_id === pin.baseVersionId)
    && equal(rows.map(row => row.name).sort(), expectedBindings.map(row => row.name).sort())
    && new Set(rows.map(row => row.name)).size === rows.length,
  `${app} inheritance template does not exactly cover qualified non-asset bindings`);
  fail(basePlan.assetUploadRecipe?.protocol === 'workers-static-assets-upload-v1'
    && basePlan.assetUploadRecipe.completionJwtRequired === true
    && basePlan.assetUploadRecipe.completionJwtMemoryOnly === true
    && basePlan.assetUploadRecipe.completionJwtPersisted === false
    && basePlan.assetUploadRecipe.providerManifestBytesPersisted === false
    && basePlan.assetUploadRecipe.requiresReviewedRetainedReleaseCoverageEvidence === true,
  `${app} retained-asset protocol no longer requires full manifest coverage and memory-only completion JWT`);
  const expectedResolvedBindings = expectedBindings.map(row => {
    // Hash the full sanitized evidence row. The capture itself stores value
    // digests for text/json bindings and no secret contents; sender scope is
    // authority-relevant, so its address list must affect the projection hash.
    return { name: row.name, type: row.type, projectionSHA256: hash(canonical(row)) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  fail(expectedResolvedBindings.every(row => SHA.test(row.projectionSHA256))
    && new Set(expectedResolvedBindings.map(row => row.name)).size === expectedResolvedBindings.length,
  `${app} resolved binding projection is malformed`);
  return { template, mainHash: mainBytes.sha256, sourceMapHash: sourceMapBytes.sha256,
    bindingNames: rows.map(row => row.name).sort((a, b) => a.localeCompare(b)), expectedResolvedBindings };
}

function makeConfigTemplate(basePlan, activeVersionId, app) {
  const gates = GATES[app], template = clone(basePlan.versionCreateTemplate);
  fail(!template.bindings.some(row => gates.includes(row.name)), `${app} target gate already exists in inheritance template`);
  template.bindings = template.bindings.map(row => ({ ...row, version_id: activeVersionId }));
  template.bindings.push(...gates.map(name => ({ name, type: 'plain_text', text: 'true' })));
  template.bindings.sort((a, b) => a.name.localeCompare(b.name));
  return template;
}

function gateRows(worker, app) {
  const wanted = GATES[app], locations = [worker.version.resources.bindings, worker.settings.bindings, worker.modern.bindings];
  for (const rows of locations) {
    fail(Array.isArray(rows), `${app} binding snapshot is malformed`);
    for (const name of wanted) {
      const hits = rows.filter(row => row.name === name);
      fail(hits.length === 0, `${app} gate already exists in a binding snapshot`);
    }
  }
  for (const name of wanted) fail(!Object.hasOwn(worker.modern.env ?? {}, name), `${app} gate exists in modern environment snapshot`);
}

function validateClientDelta(baseline, current) {
  const before = baseline.workers.client, after = current.workers.client, gates = GATES.client;
  fail(after.activeVersionId !== before.activeVersionId && after.latestVersionId === after.activeVersionId
    && UUID.test(after.activeVersionId), 'Client pilot candidate is not the current active/latest version');
  for (const name of gates) {
    fail((before.selectedFlags[name] === undefined || before.selectedFlags[name] === null || before.selectedFlags[name] === 'false')
      && after.selectedFlags[name] === 'true', `Client gate ${name} is not the exact default-off to true delta`);
  }
  const flagProjection = flags => Object.fromEntries(Object.entries(flags).filter(([name]) => !gates.includes(name)));
  fail(equal(flagProjection(before.selectedFlags), flagProjection(after.selectedFlags)), 'Client non-pilot flags changed');
  fail(equal(baseline.schema, current.schema)
    && equal(baseline.workers.operations, current.workers.operations)
    && equal(baseline.workers.sync, current.workers.sync),
  'Ops, Sync, or shared schema changed during the Client-first step');
  for (const rows of ['version.resources','settings','modern']) {
    const select = worker => rows === 'version.resources' ? worker.version.resources.bindings
      : rows === 'settings' ? worker.settings.bindings : worker.modern.bindings;
    const a = select(before), b = select(after);
    fail(Array.isArray(a) && Array.isArray(b), 'Client binding snapshot is malformed');
    const strip = entries => entries.filter(row => !gates.includes(row.name));
    const additions = b.filter(row => gates.includes(row.name));
    fail(equal(strip(a), strip(b)) && additions.length === gates.length
      && gates.every(name => additions.filter(row => row.name === name).length === 1
        && additions.find(row => row.name === name).type === 'plain_text'
        && additions.find(row => row.name === name).textSHA256 === hash(JSON.stringify('true'))),
    `Client ${rows} bindings are not exactly the two inquiry gates`);
  }
  fail(equal(Object.keys(before.modern.env ?? {}).filter(name => !gates.includes(name)).sort(),
      Object.keys(after.modern.env ?? {}).filter(name => !gates.includes(name)).sort())
    && Object.keys(before.modern.env ?? {}).every(name => gates.includes(name) || equal(before.modern.env[name], after.modern.env?.[name]))
    && gates.every(name => after.modern.env?.[name]?.type === 'plain_text'
      && after.modern.env[name].textSHA256 === hash(JSON.stringify('true'))),
  'Client modern environment does not expose exactly the requested true flag hashes');
  // The independently read current capture is accepted only if all runtime,
  // schedules, schema, module bytes, and non-gate controls remain unchanged.
  // Cloudflare assigns a new deployment/version identity, creation time and
  // measured startup duration even when only these two bindings change.
  const deploymentProjection = deployment => Object.fromEntries(Object.entries(deployment)
    .filter(([key]) => !['id','created_on'].includes(key)));
  const projection = worker => ({ workerName: worker.workerName, deployment: deploymentProjection(worker.deployment),
    version: { resources: { script: { handlers: worker.version.resources.script.handlers,
      named_handlers: worker.version.resources.script.named_handlers,
      last_deployed_from: worker.version.resources.script.last_deployed_from },
      script_runtime: worker.version.resources.script_runtime,
      bindings: worker.version.resources.bindings.filter(row => !gates.includes(row.name)) } },
    settings: { ...worker.settings, bindings: worker.settings.bindings.filter(row => !gates.includes(row.name)) },
    modern: { ...Object.fromEntries(Object.entries(worker.modern)
      .filter(([key]) => !['id','number','created_on','startup_time_ms'].includes(key))),
      modules: worker.modern.modules, env: Object.fromEntries(Object.entries(worker.modern.env ?? {}).filter(([name]) => !gates.includes(name))),
      bindings: worker.modern.bindings.filter(row => !gates.includes(row.name)) },
    schedules: worker.schedules, selectedFlags: flagProjection(worker.selectedFlags) });
  const bp = projection(before), cp = projection(after);
  bp.deployment.versions = bp.deployment.versions.map(row => ({ ...row, version_id: CURRENT.client.activeVersionId }));
  cp.deployment.versions = cp.deployment.versions.map(row => ({ ...row, version_id: CURRENT.client.activeVersionId }));
  fail(equal(bp, cp), 'Client runtime or non-gate controls changed with pilot flags');
}

function controlsContinuityProjection(controls) {
  const projection = clone(controls);
  delete projection.observedAt;
  for (const worker of Object.values(projection.workers ?? {})) {
    // startup_time_ms is a measured runtime value already reviewed during the
    // activation readback, not a configuration or deployment identity field.
    if (worker.modern) delete worker.modern.startup_time_ms;
    // This digest covers the raw Worker responses, including startup_time_ms;
    // all other captured fields remain compared directly in the projection.
    delete worker.rawControlSHA256;
  }
  return projection;
}

function validateClientActivationContinuity(activationControls, currentControls) {
  fail(equal(controlsContinuityProjection(activationControls), controlsContinuityProjection(currentControls)),
    'fresh controls differ from the hash-pinned Client activation proof beyond observation time or startup metrics');
}

function makeClientReceipt(clientPlan, baselineControlsSHA256, currentControlsSHA256, currentControls) {
  return { schemaVersion: 2, purpose: CLIENT_RECEIPT_PURPOSE, accountId: STAGING_ACCOUNT_ID,
    workerName: CURRENT.client.workerName, baselineVersionId: CURRENT.client.activeVersionId,
    candidateVersionId: currentControls.workers.client.activeVersionId, deploymentId: currentControls.workers.client.deployment.id,
    sourceCommit: SOURCE_COMMITS.client, planSHA256: hashStagingNativeInquiryPilotV2PlanFile(clientPlan), baselineControlsSHA256, controlsSHA256: currentControlsSHA256,
    observedAt: currentControls.observedAt, readbackVerified: true, exactClientDeltaVerified: true,
    activeRuntimeUnchanged: true, otherControlsUnchanged: true, schemaUnchanged: true,
    resourceWrites: 0, applicationRowsRead: 0 };
}

function validateClientReceipt(receipt, receiptSHA256, expected, controls) {
  fail(keysAre(receipt, CLIENT_RECEIPT_KEYS) && receipt.schemaVersion === 2
    && receipt.purpose === CLIENT_RECEIPT_PURPOSE && receipt.accountId === STAGING_ACCOUNT_ID
    && receipt.workerName === CURRENT.client.workerName && receipt.baselineVersionId === CURRENT.client.activeVersionId
    && receipt.candidateVersionId === controls.workers.client.activeVersionId
    && receipt.deploymentId === controls.workers.client.deployment.id
    && receipt.sourceCommit === SOURCE_COMMITS.client && receipt.planSHA256 === expected.planSHA256
    && receipt.baselineControlsSHA256 === expected.baselineControlsSHA256
    && receipt.controlsSHA256 === expected.controlsSHA256 && receipt.observedAt === controls.observedAt
    && receipt.readbackVerified === true && receipt.exactClientDeltaVerified === true
    && receipt.activeRuntimeUnchanged === true && receipt.otherControlsUnchanged === true
    && receipt.schemaUnchanged === true && receipt.resourceWrites === 0 && receipt.applicationRowsRead === 0
    && SHA.test(receiptSHA256 ?? ''), 'independent Client-pilot receipt is missing, malformed, or mismatched');
}

/** Pure evidence compiler. File pinning is performed by compile...FromFiles below. */
export function compileStagingNativeInquiryPilotV2PlanFromEvidence({ application, baselineControls,
  referenceControls = baselineControls, currentControls = baselineControls, basePlan, clientBasePlan, now = Date.now(),
  baselineControlsSHA256 = hash(canonical(baselineControls)), currentControlsSHA256 = hash(canonical(currentControls)),
  clientPilotControls, clientPilotControlsSHA256, clientPilotReceipt, clientPilotReceiptSHA256 } = {}) {
  fail(application === 'client' || application === 'operations', 'only fixed Client-first pilot targets are allowed');
  validateFreshControls(referenceControls, Date.parse(referenceControls.observedAt) + 1);
  if (application === 'operations') {
    fail(baselineControlsSHA256 === CLIENT_PILOT_BASELINE.sha256,
      'Operations historical baseline is not the exact original C82 Client-plan input');
    // This is an immutable comparison anchor only. Its fixed byte hash plus
    // pinned-reference equality below preserve identity; the current capture
    // and Client receipt are independently required to be fresh.
    validateFreshControls(baselineControls, Date.parse(baselineControls.observedAt) + 1);
  } else validateFreshControls(baselineControls, now);
  validateFreshControls(currentControls, now, { allowClientPilotVersion: application === 'operations' });
  const withoutObservedAt = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'observedAt'));
  fail(equal(withoutObservedAt(referenceControls), withoutObservedAt(baselineControls)),
    'historical C82 controls differ from the pinned after-both-active reference');
  fail(SHA.test(baselineControlsSHA256) && SHA.test(currentControlsSHA256), 'controls file hashes are missing');
  fail(hash(canonical(baselineControls.schema)) === basePlan.databaseSchemaSHA256,
    'current staging schema differs from the held base plan');
  const baseline = baselineControls.workers[application], current = currentControls.workers[application];
  assertAllFlagsHeldOff(baselineControls.workers.operations, 'operations');
  if (application === 'client') assertAllFlagsHeldOff(baselineControls.workers.client, 'client');
  const checked = validateBasePlan(basePlan, application, baselineControls);
  gateRows(baseline, application);
  if (application === 'operations') {
    fail(clientPilotControls && clientPilotControlsSHA256 === CLIENT_PILOT_ACTIVATION_CONTROLS.sha256
      && SHA.test(clientPilotControlsSHA256), 'Operations step requires the pinned Client activation controls capture');
    fail(clientPilotReceiptSHA256 === CLIENT_PILOT_ACTIVATION_RECEIPT.sha256,
      'Operations step requires the pinned Client activation readback receipt');
    validateFreshControls(clientPilotControls, Date.parse(clientPilotControls.observedAt) + 1,
      { allowClientPilotVersion: true });
    fail(Date.parse(clientPilotControls.observedAt) > Date.parse(baselineControls.observedAt),
      'Client activation proof does not follow the historical C82 baseline');
    fail(Date.parse(currentControls.observedAt) >= Date.parse(clientPilotControls.observedAt),
      'fresh current controls predate the pinned Client activation proof');
    validateClientDelta(baselineControls, clientPilotControls);
    validateClientActivationContinuity(clientPilotControls, currentControls);
    fail(clientBasePlan, 'Ops plan requires the independently pinned Client base plan');
    const clientChecked = validateBasePlan(clientBasePlan, 'client', baselineControls);
    gateRows(baselineControls.workers.client, 'client');
    const clientPlan = makePlan('client', baselineControls, baselineControls, clientBasePlan, clientChecked,
      BASE_PLANS.client.sha256, baselineControlsSHA256, baselineControlsSHA256, null);
    const clientPlanSHA256 = hashStagingNativeInquiryPilotV2PlanFile(clientPlan);
    fail(clientPlanSHA256 === CLIENT_PILOT_HELD_PLAN_SHA256,
      'historical C82 no longer reproduces the original Client held-plan hash');
    const expected = { planSHA256: clientPlanSHA256, baselineControlsSHA256,
      controlsSHA256: clientPilotControlsSHA256 };
    validateClientReceipt(clientPilotReceipt, clientPilotReceiptSHA256, expected, clientPilotControls);
  } else {
    fail(!clientPilotControls && !clientPilotControlsSHA256,
      'Client step cannot consume an Operations Client-activation proof');
    fail(equal(currentControls, baselineControls), 'Client config-only plan must start from the unchanged after-both-active capture');
  }
  return makePlan(application, baselineControls, currentControls, basePlan, checked,
    BASE_PLANS[application].sha256, baselineControlsSHA256, currentControlsSHA256,
    application === 'operations' ? { receiptSHA256: clientPilotReceiptSHA256,
      candidateVersionId: clientPilotControls.workers.client.activeVersionId,
      deploymentId: clientPilotControls.workers.client.deployment.id,
      planSHA256: clientPilotReceipt.planSHA256, baselineControlsSHA256,
      controlsSHA256: clientPilotControlsSHA256, controlsObservedAt: clientPilotControls.observedAt } : null);
}

function makePlan(application, baselineControls, currentControls, basePlan, checked,
  basePlanSHA256, baselineControlsSHA256, controlsSHA256, clientPilotContext) {
  const baseline = baselineControls.workers[application], current = currentControls.workers[application];
  const versionCreateTemplate = makeConfigTemplate(basePlan, baseline.activeVersionId, application);
  const plan = {
    schemaVersion: 2, contract: CONTRACT, purpose: 'staging-native-inquiry-pilot-configuration-only-v2',
    application, step: application === 'client' ? 1 : 2, accountId: STAGING_ACCOUNT_ID,
    workerName: CURRENT[application].workerName, sourceCommit: SOURCE_COMMITS[application],
    sourceProfiles: clone(SOURCE_COMMITS),
    baselineVersionId: baseline.activeVersionId, currentActiveVersionId: current.activeVersionId,
    currentLatestVersionId: current.latestVersionId, controlsSHA256, baselineControlsSHA256,
    basePlanSHA256, basePlanContract: basePlan.contract, basePlanSchemaVersion: basePlan.schemaVersion,
    databaseSchemaSHA256: basePlan.databaseSchemaSHA256, mainModuleSHA256: checked.mainHash,
    sourceMapSHA256: checked.sourceMapHash, controlsObservedAt: currentControls.observedAt,
    baselineControlsObservedAt: baselineControls.observedAt,
    installedCodeMatchesQualifiedBuild: true, installedRuntimeAndBindingsMatchBase: true, schemaMatchesBase: true,
    preservedBindings: checked.bindingNames, configurationDelta: GATES[application].map(name => ({ name, type: 'plain_text', text: 'true' })),
    expectedResolvedBindings: clone(checked.expectedResolvedBindings),
    clientPilotContext, held: true, offlineOnly: true, deploymentEnabled: false, executionAllowed: false,
    holdReasons: ['offline-configuration-plan-only','fresh-hashed-retained-asset-manifest-required',
      'complete-48-hour-retained-asset-coverage-required','runtime-upload-and-completion-jwt-qualification-required',
      'qualified-one-shot-candidate-procedure-required'],
    versionCreateTemplate,
    assetUploadRecipe: clone(basePlan.assetUploadRecipe),
    futureExecutionPrerequisites: ['fresh fixed-account controls capture',
      'complete hashed retained-asset manifest and verified local bytes',
      'actual remote namespace coverage for every required retained path and its bytes',
      'successful bounded asset upload-session completion with JWT held in memory only',
      'separately reviewed candidate creation and activation procedure'],
    noIdentityOrCapabilityGrant: true, noMigrationConfig: true, noFileOrFinancePermission: true,
    noNotificationCreation: true, noOpsSyncUpdate: true,
  };
  fail(versionCreateTemplate.deploy === false && !Object.hasOwn(versionCreateTemplate, 'assets')
    && !Object.hasOwn(versionCreateTemplate, 'migrations') && versionCreateTemplate.bindings.every(row => row.type !== 'secret_text'),
  'held template acquired execution, JWT, migration, or secret content');
  noSecretValues(plan);
  return plan;
}

function readPinnedJson(pin, maxBytes, label) {
  fail(pin && path.isAbsolute(pin.path) && SHA.test(pin.sha256 ?? ''), `${label} file pin is malformed`);
  let descriptor;
  try {
    const pathStat = fs.lstatSync(pin.path);
    fail(pathStat.isFile() && !pathStat.isSymbolicLink() && pathStat.nlink === 1
      && pathStat.size > 0 && pathStat.size <= maxBytes, `${label} is not a bounded single-link regular file`);
    descriptor = fs.openSync(pin.path, 'r');
    const before = fs.fstatSync(descriptor);
    fail(before.isFile() && before.nlink === 1 && before.dev === pathStat.dev && before.ino === pathStat.ino
      && before.size === pathStat.size, `${label} changed while opening`);
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor);
    fail(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
      && after.ino === before.ino && after.dev === before.dev && hash(bytes) === pin.sha256,
    `${label} hash or file identity differs from its pin`);
    return { value: JSON.parse(bytes.toString('utf8')), sha256: pin.sha256, bytes };
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Fixed-input file wrapper for offline preparation. The original C82 baseline,
 * Client activation capture/receipt, reference, and base plans are immutable pins;
 * only the current controls input must be fresh at the real wall clock. */
export function compileStagingNativeInquiryPilotV2PlanFromFiles({ application, baselineControlsFile,
  currentControlsFile = baselineControlsFile, clientPilotControlsFile, clientPilotReceiptFile,
  clientPilotReceiptSHA256 } = {}) {
  if (application === 'operations') fail(baselineControlsFile?.path === CLIENT_PILOT_BASELINE.path
    && baselineControlsFile?.sha256 === CLIENT_PILOT_BASELINE.sha256,
  'Operations step must use the byte-pinned historical C82 Client-plan baseline');
  const baselineControl = readPinnedJson(baselineControlsFile, 16 * 1024 * 1024,
    application === 'operations' ? 'historical C82 Client-plan baseline' : 'fresh pre-pilot controls');
  const currentControl = readPinnedJson(currentControlsFile, 16 * 1024 * 1024, 'current controls');
  const planPin = BASE_PLANS[application];
  fail(planPin, 'unsupported application');
  const basePlan = readPinnedJson(planPin, 128 * 1024 * 1024, `${application} held base plan`);
  let clientActivationControl, clientReceipt;
  if (application === 'operations') {
    fail(clientPilotControlsFile?.path === CLIENT_PILOT_ACTIVATION_CONTROLS.path
      && clientPilotControlsFile?.sha256 === CLIENT_PILOT_ACTIVATION_CONTROLS.sha256,
    'Operations step requires the exact hash-pinned Client activation controls capture');
    fail(clientPilotReceiptFile === CLIENT_PILOT_ACTIVATION_RECEIPT.path
      && clientPilotReceiptSHA256 === CLIENT_PILOT_ACTIVATION_RECEIPT.sha256,
    'Operations step requires the exact hash-pinned Client activation readback receipt');
    clientActivationControl = readPinnedJson(CLIENT_PILOT_ACTIVATION_CONTROLS, 16 * 1024 * 1024,
      'Client activation controls');
    clientReceipt = readPinnedJson(CLIENT_PILOT_ACTIVATION_RECEIPT, 1024 * 1024, 'Client activation readback receipt');
  } else fail(!clientPilotControlsFile && !clientPilotReceiptFile && clientPilotReceiptSHA256 === undefined,
    'Client step cannot consume an Operations Client-activation proof');
  const clientPlanPin = BASE_PLANS.client;
  const clientBasePlan = application === 'operations'
    ? readPinnedJson(clientPlanPin, 128 * 1024 * 1024, 'Client held base plan') : null;
  const referenceControl = readPinnedJson(BASE_CONTROLS, 16 * 1024 * 1024, 'pinned post-Operations reference controls');
  return compileStagingNativeInquiryPilotV2PlanFromEvidence({ application,
    referenceControls: referenceControl.value, baselineControls: baselineControl.value,
    currentControls: currentControl.value, baselineControlsSHA256: baselineControl.sha256,
    currentControlsSHA256: currentControl.sha256, basePlan: basePlan.value, clientBasePlan: clientBasePlan?.value,
    clientPilotControls: clientActivationControl?.value, clientPilotControlsSHA256: clientActivationControl?.sha256,
    clientPilotReceipt: clientReceipt?.value, clientPilotReceiptSHA256: clientReceipt?.sha256 });
}

export const stagingNativeInquiryPilotV2PlanConstants = Object.freeze({ CONTRACT, CLIENT_RECEIPT_PURPOSE,
  accountId: STAGING_ACCOUNT_ID, sourceCommits: SOURCE_COMMITS, baselineControls: BASE_CONTROLS,
  clientPilotBaselineControls: CLIENT_PILOT_BASELINE, clientPilotHeldPlanSHA256: CLIENT_PILOT_HELD_PLAN_SHA256,
  clientPilotActivationControls: CLIENT_PILOT_ACTIVATION_CONTROLS,
  clientPilotActivationReceipt: CLIENT_PILOT_ACTIVATION_RECEIPT,
  basePlans: BASE_PLANS, current: CURRENT, gates: GATES });
