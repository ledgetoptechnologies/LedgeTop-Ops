import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  ensureDeploymentConfiguredProjectAlphaConnectors, listProjectAlphaConnectors, resolveProjectAlphaConnector,
  type ProjectAlphaConnectorEnvironment,
} from "../src/worker/project-alpha-connectors";

const key = (seed: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const credential = (seed: number) => ({ snapshotApiKey: `private-api-key-${seed}`, eventCurrent: { keyId: `key-${seed}`, algorithm: "ed25519", value: key(seed) } });
const primary = "project-alpha:primary", secondary = "project-alpha:secondary";
const commitments = new Map<string, { keyId: string; algorithm: "ed25519"; fingerprint: string }>();
async function commitment(seed: number) {
  const bytes = new Uint8Array(32).fill(seed), prefix = new TextEncoder().encode("ed25519\0");
  const value = new Uint8Array(prefix.length + bytes.length); value.set(prefix); value.set(bytes, prefix.length);
  return { keyId: `key-${seed}`, algorithm: "ed25519" as const,
    fingerprint: [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map(byte => byte.toString(16).padStart(2, "0")).join("") };
}
let runtime: Miniflare, db: D1Database, env: ProjectAlphaConnectorEnvironment;
function source(sourceId: string, credentialRef: string, profile: "primary_legacy" | "business_data", origin: string, draftQuoteSource?: string) {
  return { sourceId, producerBindingId: sourceId === primary ? "ltds-project-alpha" : "ltt-project-alpha", displayName: sourceId === primary ? "LTDS Project Alpha" : "LTT Project Alpha",
    snapshotOrigin: origin, applicationKey: "ltds_ops", profile, enabled: true, readVisible: true, ...(draftQuoteSource ? { draftQuoteSource } : {}),
    revision: { credentialRef, snapshotBasePath: "/", accessIssuer: "https://access.example.test", accessAudience: `audience-${credentialRef}`, accessSubject: `service-${credentialRef}`,
      eventCurrent: commitments.get(credentialRef)! } };
}
beforeEach(async () => {
  commitments.set("ltds_primary", await commitment(1)); commitments.set("ltt_secondary", await commitment(2));
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith(".sql") && file <= "0035_project_alpha_connectors.sql").sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(file, directory), "utf8")).map(sql => db.prepare(sql)));
  await db.batch(splitD1MigrationStatements(readFileSync(new URL("0050_project_alpha_draft_quote_credentials.sql", directory), "utf8")).map(sql => db.prepare(sql)));
  env = { OPS_DB: db, PROJECT_ALPHA_BASE_URL: "https://primary.example.test", PROJECT_ALPHA_API_KEY: "legacy-primary-api-key", APPLICATION_KEY: "ltds_ops",
    PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: key(1),
    PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS: JSON.stringify({ version: 1, sets: { ltds_primary: { snapshotApiKey: "private-api-key-1" }, ltt_secondary: { snapshotApiKey: "private-api-key-2" } } }),
    PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS: JSON.stringify({ version: 1, sets: { ltds_primary: { eventCurrent: credential(1).eventCurrent }, ltt_secondary: { eventCurrent: credential(2).eventCurrent } } }),
    PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify({ version: 1, sources: [source(primary, "ltds_primary", "primary_legacy", "https://primary.example.test"), source(secondary, "ltt_secondary", "business_data", "https://secondary.example.test")] }) };
});
afterEach(async () => { await runtime.dispose(); });

describe("deployment-configured Project Alpha sources", () => {
  it("bootstraps LTDS then LTT from deployment configuration and never exposes credentials", async () => {
    await ensureDeploymentConfiguredProjectAlphaConnectors({ ...env, PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS: undefined });
    const connectors = await listProjectAlphaConnectors(env);
    expect(connectors).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: primary, state: "active", readVisible: true, profile: "primary_legacy" }),
      expect.objectContaining({ sourceId: secondary, state: "active", readVisible: true, profile: "business_data" }),
    ]));
    expect(JSON.stringify(connectors)).not.toContain("private-api-key");
    expect(JSON.stringify(connectors)).not.toContain(key(1));
    const resolved = await resolveProjectAlphaConnector({ ...env, PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS: undefined }, secondary, "events");
    expect(resolved.proof).toMatchObject({ mode: "registry", sourceId: secondary, profile: "business_data" });
    expect(resolved.snapshot).toBeNull();
    expect(resolved.event?.current.keyId).toBe("key-2");
    const snapshot = await resolveProjectAlphaConnector({ ...env, PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS: undefined }, secondary, "snapshot");
    expect(snapshot.snapshot?.baseUrl).toBe("https://secondary.example.test");
    expect(snapshot.event).toBeNull();
  });

  it("keeps Ops Sync read-only and requires its enabled exact manifest commitment", async () => {
    await ensureDeploymentConfiguredProjectAlphaConnectors({ ...env, PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS: undefined });
    const before = await db.prepare("SELECT count(*) total FROM pa_connector_audit").first<number>("total");
    const syncEnv = { ...env, PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS: undefined };
    await expect(resolveProjectAlphaConnector(syncEnv, secondary, "events")).resolves.toMatchObject({ event: { current: { keyId: "key-2" } } });
    expect(await db.prepare("SELECT count(*) total FROM pa_connector_audit").first<number>("total")).toBe(before);

    const disabled = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SOURCES!) as { version: number; sources: Array<{
      enabled: boolean; revision: { eventCurrent: { fingerprint: string } } } & Record<string, unknown>> };
    disabled.sources[1]!.enabled = false;
    await expect(resolveProjectAlphaConnector({ ...syncEnv, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(disabled) }, secondary, "events"))
      .rejects.toMatchObject({ code: "unavailable" });
    disabled.sources[1]!.enabled = true;
    disabled.sources[1]!.revision.eventCurrent.fingerprint = "f".repeat(64);
    await expect(resolveProjectAlphaConnector({ ...syncEnv, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(disabled) }, secondary, "events"))
      .rejects.toMatchObject({ code: "changed" });
    expect(await db.prepare("SELECT count(*) total FROM pa_connector_audit").first<number>("total")).toBe(before);
  });

  it("does not let an Ops Sync event request materialize an empty registry", async () => {
    const syncEnv = { ...env, PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS: undefined };
    await expect(resolveProjectAlphaConnector(syncEnv, primary, "events")).rejects.toMatchObject({ code: "unavailable" });
    await expect(resolveProjectAlphaConnector(syncEnv, secondary, "events")).rejects.toMatchObject({ code: "unavailable" });
    expect(await db.prepare("SELECT count(*) total FROM pa_connectors").first<number>("total")).toBe(0);
    expect(await db.prepare("SELECT count(*) total FROM pa_connector_audit").first<number>("total")).toBe(0);
  });

  it("fails closed on an immutable deployment identity drift instead of retargeting a source", async () => {
    await ensureDeploymentConfiguredProjectAlphaConnectors(env);
    const manifest = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SOURCES!) as { version: number; sources: Array<Record<string, unknown>> };
    manifest.sources[1]!.snapshotOrigin = "https://attacker.example.test";
    await expect(ensureDeploymentConfiguredProjectAlphaConnectors({ ...env, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(manifest) }))
      .rejects.toMatchObject({ code: "changed" });
    expect((await listProjectAlphaConnectors(env)).find(row => row.sourceId === secondary)?.snapshotOrigin).toBe("https://secondary.example.test");
  });

  it("does not silently admit a secondary manifest without a matching primary entry", async () => {
    await expect(ensureDeploymentConfiguredProjectAlphaConnectors({ ...env, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify({ version: 1, sources: [source(secondary, "ltt_secondary", "business_data", "https://secondary.example.test")] }) }))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(await listProjectAlphaConnectors(env)).toEqual([]);
  });

  it("validates every credential before mutating any source", async () => {
    const credentials = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS!) as { version: number; sets: Record<string, unknown> };
    delete credentials.sets.ltt_secondary;
    await expect(ensureDeploymentConfiguredProjectAlphaConnectors({ ...env, PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS: JSON.stringify(credentials) }))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(await db.prepare("SELECT count(*) total FROM pa_connectors").first("total")).toBe(0);
    expect(await db.prepare("SELECT count(*) total FROM pa_connector_audit").first("total")).toBe(0);
  });

  it("treats a deployed manifest as an allow-list for stale registry rows", async () => {
    await ensureDeploymentConfiguredProjectAlphaConnectors(env);
    const manifest = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SOURCES!) as { version: number; sources: Array<Record<string, unknown>> };
    manifest.sources = manifest.sources.filter(row => row.sourceId === primary);
    const reduced = { ...env, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(manifest) };
    expect((await listProjectAlphaConnectors(reduced)).map(row => row.sourceId)).toEqual([primary]);
    await expect(resolveProjectAlphaConnector(reduced, secondary, "events")).rejects.toMatchObject({ code: "unavailable" });
    await ensureDeploymentConfiguredProjectAlphaConnectors(reduced);
    expect(await db.prepare("SELECT state,read_visible FROM pa_connectors WHERE source_id=?").bind(secondary).first())
      .toEqual({ state: "suspended", read_visible: 0 });
  });

  it("rejects every source when production requires a missing manifest", async () => {
    const required = { ...env, PROJECT_ALPHA_CONNECTOR_SOURCES: undefined, PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED: "true" };
    await expect(ensureDeploymentConfiguredProjectAlphaConnectors(required)).rejects.toMatchObject({ code: "credentials_unavailable" });
    await expect(resolveProjectAlphaConnector(required, primary, "events")).rejects.toMatchObject({ code: "credentials_unavailable" });
    await expect(listProjectAlphaConnectors(required)).rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(await db.prepare("SELECT count(*) total FROM pa_connectors").first("total")).toBe(0);
    expect(await db.prepare("SELECT count(*) total FROM pa_connector_audit").first("total")).toBe(0);
  });

  it("requires explicit enablement and visibility and never hides the primary", async () => {
    const manifest = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SOURCES!) as { version: number; sources: Array<Record<string, unknown>> };
    delete manifest.sources[1]!.enabled;
    await expect(ensureDeploymentConfiguredProjectAlphaConnectors({ ...env, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(manifest) }))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    manifest.sources[1]!.enabled = true;
    manifest.sources[0]!.readVisible = false;
    await expect(ensureDeploymentConfiguredProjectAlphaConnectors({ ...env, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(manifest) }))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(await listProjectAlphaConnectors(env)).toEqual([]);
  });

  it("keeps each PA's draft-command source deployment-owned and isolated", async () => {
    const manifest = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SOURCES!) as { version: number; sources: Array<Record<string, unknown>> };
    manifest.sources[1]!.draftQuoteSource = "ltt-operations";
    const snapshotCredentials = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS!) as { version: number; sets: Record<string, Record<string, unknown>> };
    snapshotCredentials.sets.ltds_primary!.draftQuote = { apiKey: "ltds-draft-key", hmacSecret: "ltds-draft-secret-at-least-thirty-two-bytes" };
    snapshotCredentials.sets.ltt_secondary!.draftQuote = { apiKey: "ltt-draft-key", hmacSecret: "ltt-draft-secret-at-least-thirty-two-bytes" };
    const configured = { ...env, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(manifest),
      PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS: JSON.stringify(snapshotCredentials) };
    const primaryQuote = await resolveProjectAlphaConnector(configured, primary, "draft_quote");
    const secondaryQuote = await resolveProjectAlphaConnector(configured, secondary, "draft_quote");
    expect(primaryQuote.draftQuote).toMatchObject({ source: "ltds-operations", apiKey: "ltds-draft-key" });
    expect(secondaryQuote.draftQuote).toMatchObject({ source: "ltt-operations", apiKey: "ltt-draft-key" });
    manifest.sources[1]!.draftQuoteSource = "ltds-operations";
    await expect(resolveProjectAlphaConnector({ ...configured, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(manifest) }, secondary, "draft_quote"))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
  });

  it("does not enable a secondary draft quote when its manifest omits a source identity", async () => {
    const snapshotCredentials = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS!) as { version: number; sets: Record<string, Record<string, unknown>> };
    snapshotCredentials.sets.ltt_secondary!.draftQuote = { apiKey: "ltt-draft-key", hmacSecret: "ltt-draft-secret-at-least-thirty-two-bytes" };
    const configured = { ...env, PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS: JSON.stringify(snapshotCredentials) };
    expect((await resolveProjectAlphaConnector(configured, secondary, "draft_quote")).draftQuote).toBeNull();
    const malformed = JSON.parse(env.PROJECT_ALPHA_CONNECTOR_SOURCES!) as { version: number; sources: Array<Record<string, unknown>> };
    malformed.sources[1]!.draftQuoteSource = "LTT Operations";
    await expect(resolveProjectAlphaConnector({ ...configured, PROJECT_ALPHA_CONNECTOR_SOURCES: JSON.stringify(malformed) }, secondary, "draft_quote"))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
  });
});
