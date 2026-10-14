import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildStagingOpsSyncProfile203, TARGET } from "./staging-ops-sync-v203.mjs";
import { buildConnectorManifest203, connectorMetadataTemplate203, connectorPublicKeyFingerprint203 } from "./staging-pa-ops-connectors-v203.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = () => JSON.parse(fs.readFileSync(new URL("./staging-ops-sync-v203.template.json", import.meta.url), "utf8"));
const publicKey = () => crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
const owner = { staffId: "staff-owner", accessSubject: "access|owner" };
function legacy() {
  return { ...template(), phase: "legacy-bootstrap", owner, primaryBootstrap: {
    snapshotOrigin: TARGET.primaryOrigin, applicationKey: TARGET.applicationKey,
    accessIssuer: "https://staging-team.cloudflareaccess.com", accessAudience: "a".repeat(64),
    accessClientId: `${"b".repeat(32)}.access`, eventKeyId: "pa_ed25519_1234567890abcdef", eventPublicKey: publicKey(),
  } };
}
function registry() {
  const connectors = connectorMetadataTemplate203();
  for (const [index, source] of Object.values(connectors.sources).entries()) {
    source.sourceId = index ? "project-alpha:source-2-staging" : "project-alpha:primary";
    source.producerBindingId = `pa-staging-${index}`;
    source.applicationKey = index ? "ledgetop_ops_stage_two_staging" : TARGET.applicationKey;
    source.publicEventKey = publicKey(); source.enabled = true; source.readVisible = true;
    Object.assign(source.revision, { credentialRef: `staging_${index}`, snapshotBasePath: "/",
      accessIssuer: "https://staging-team.cloudflareaccess.com", accessAudience: "a".repeat(64), accessSubject: `${String(index + 1).repeat(32)}.access`,
      eventCurrent: { keyId: `pa_ed25519_${String(index + 1).repeat(16)}`, algorithm: "ed25519", fingerprint: connectorPublicKeyFingerprint203(source.publicEventKey) } });
  }
  return { ...template(), phase: "registry", owner, connectors };
}

test("shipped null template compiles an isolated inert receiver without production credentials or cron", async () => {
  const result = await buildStagingOpsSyncProfile203(template());
  assert.deepEqual(result.enabledSourceIds, []); assert.equal(result.manifest, null);
  assert.equal(result.config.name, TARGET.worker); assert.equal(result.config.vars.ENVIRONMENT, "staging");
  assert.equal(result.config.vars.EXPECTED_HOST, TARGET.host); assert.equal(result.config.vars.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED, "true");
  assert.equal(result.config.vars.PROJECT_ALPHA_ALLOW_LEGACY_HMAC, "false");
  assert.equal(result.config.vars.CF_ACCESS_AUD, ""); assert.equal(result.config.vars.TEAM_DOMAIN, "");
  assert.deepEqual(result.config.triggers.crons, []);
  assert.deepEqual(result.config.d1_databases.map(row => row.database_id), [TARGET.opsDb, TARGET.deliveryDb]);
  assert.deepEqual(result.config.services.map(row => [row.service, row.entrypoint]), [
    ["ledgetop-clients-staging", "OpsSyncPortalProjectionIngress"], ["ledgetop-ops-staging", "ProjectAlphaDeliveryIntentIngress"],
  ]);
  assert.equal(result.mutationsPerformed, false); assert.equal(result.deploymentAuthorized, false); assert.equal(result.liveAcceptanceProven, false);
  assert.equal(result.providerReadbackRequired.workerMustBeAbsent, true);
  assert.equal(result.providerReadbackRequired.connectorManifestMustBeAbsent, true);
  const serialized = JSON.stringify(result.config);
  for (const forbidden of ["6ebf7514-d306-4615-ae56-ad869c874dbd", "7f40a7b7-c3ec-470e-a626-e798867f71f8", "LTDS Ops Users", '"ledgetop-clients"', '"ledgetop-ops"']) assert.equal(serialized.includes(forbidden), false);
  const current = JSON.parse(fs.readFileSync(path.join(root, "apps/ops-sync/wrangler.jsonc"), "utf8"));
  assert.equal(result.config.compatibility_date, current.compatibility_date);
  assert.deepEqual(result.config.compatibility_flags, current.compatibility_flags);
  assert.equal(result.config.main, path.join(root, "apps/ops-sync", current.main));
});

test("legacy bootstrap uses only staged primary public verifier and declares exact existing attestation function", async () => {
  const input = legacy(), result = await buildStagingOpsSyncProfile203(input);
  assert.equal(result.config.vars.PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY, input.primaryBootstrap.eventPublicKey);
  assert.equal(result.config.vars.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED, "false");
  assert.deepEqual(result.enabledSourceIds, ["project-alpha:primary"]); assert.equal(result.manifest, null);
  assert.equal(result.primaryAttestation.fingerprint, connectorPublicKeyFingerprint203(input.primaryBootstrap.eventPublicKey));
  assert.match(result.primaryAttestation.function, /resolveProjectAlphaConnector/);
  assert.equal(Object.hasOwn(result.config.vars, "PROJECT_ALPHA_WEBHOOK_HMAC_SECRET"), false);
});

test("registry receiver and Operations share byte-identical source manifest and require explicit identities", async () => {
  const input = registry(), result = await buildStagingOpsSyncProfile203(input);
  assert.equal(result.manifest, buildConnectorManifest203(input.connectors));
  assert.equal(result.config.vars.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED, "true");
  assert.equal(Object.hasOwn(result.config.vars, "PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY"), false);
  assert.deepEqual(result.requiredSecretNames, ["PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS", "PROJECT_ALPHA_CONNECTOR_SOURCES"]);
  assert.deepEqual(result.enabledSourceIds, ["project-alpha:primary", "project-alpha:source-2-staging"]);
  input.connectors.sources.stageTwo.enabled = false;
  assert.deepEqual((await buildStagingOpsSyncProfile203(input)).enabledSourceIds, ["project-alpha:primary"]);
});

test("rejects secret input, phase mixing, missing owner, incomplete identities and primary pin drift without echo", async t => {
  const cases = [
    input => { input.privateInputs.accessClientSecret = "synthetic-do-not-echo-secret"; },
    input => { input.apiKey = "synthetic-do-not-echo-secret"; },
    input => { input.owner = null; },
    input => { input.primaryBootstrap.snapshotOrigin = "https://pa.example.com"; },
    input => { input.primaryBootstrap.applicationKey = "ltds_ops"; },
    input => { input.primaryBootstrap.accessClientId = null; },
    input => { input.primaryBootstrap.accessAudience = ""; },
    input => { input.primaryBootstrap.eventPublicKey = Buffer.alloc(32).toString("base64url"); },
    input => { input.primaryBootstrap.eventPrivateKey = "synthetic-do-not-echo-secret"; },
    input => { input.connectors = registry().connectors; },
  ];
  for (const [index, mutate] of cases.entries()) await t.test(String(index), async () => {
    const input = legacy(); mutate(input);
    await assert.rejects(buildStagingOpsSyncProfile203(input), error => error.message === "Isolated staging Ops Sync profile is invalid or incomplete");
  });
  await assert.rejects(buildStagingOpsSyncProfile203({ ...template(), owner }));
  await assert.rejects(buildStagingOpsSyncProfile203({ ...registry(), primaryBootstrap: legacy().primaryBootstrap }));
  const changed = registry(); changed.connectors.sources.stageOne.revision.snapshotBasePath = "/changed";
  await assert.rejects(buildStagingOpsSyncProfile203(changed));
});

test("future binding-family or RPC type drift fails instead of inheriting a new production resource", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "staging-ops-sync203-"));
  try {
    const directory = path.join(temporary, "apps/ops-sync"); fs.mkdirSync(directory, { recursive: true });
    const base = JSON.parse(fs.readFileSync(path.join(root, "apps/ops-sync/wrangler.jsonc"), "utf8"));
    for (const changed of [
      { ...base, kv_namespaces: [{ binding: "PRODUCTION_KV", id: "production" }] },
      { ...base, services: base.services.map(row => ({ ...row, entrypoint: "WrongEntrypoint" })) },
      { ...base, d1_databases: [...base.d1_databases, { binding: "EXTRA_DB", database_name: "production", database_id: "production", migrations_dir: "migrations" }] },
    ]) {
      fs.writeFileSync(path.join(directory, "wrangler.jsonc"), JSON.stringify(changed));
      await assert.rejects(buildStagingOpsSyncProfile203(template(), { root: temporary }));
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

