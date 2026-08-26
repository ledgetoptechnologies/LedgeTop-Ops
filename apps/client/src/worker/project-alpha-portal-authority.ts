import { z } from "zod";
import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";

export type PortalAuthorityDatabase = Pick<D1Database, "prepare" | "batch">;
export interface PortalSourceAuthorityEnvironment {
  DELIVERY_DB: D1Database;
  PROJECT_ALPHA_CONNECTOR_CREDENTIALS?: string;
  PROJECT_ALPHA_PORTAL_HMAC_SECRET?: string;
  PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET?: string;
}
/** Constructed by the existing Operations connector administration after ACL
 * and coordination-barrier checks. This is not an inbound authentication DTO. */
export interface PortalAuthorityConnectorIdentity {
  sourceId: string; producerBindingId: string; snapshotOrigin: string; snapshotBasePath: string;
  applicationKey: string; profile: "business_data"; revision: number; version: number;
  state: "pending" | "active" | "suspended" | "retired";
}
export interface PortalAuthorityRevisionInput {
  credentialRef: string; accessIssuer: string; accessAudience: string; accessSubject: string;
}
export interface PortalSourceAuthoritySummary {
  sourceId: string; producerBindingId: string; applicationKey: string;
  state: "pending" | "active" | "suspended" | "retired";
  activeRevision: number; version: number; connectorRevision: number; connectorVersion: number;
}
export interface PortalSourceAuthorityProof {
  readonly sourceId: string; readonly revision: number; readonly version: number;
  readonly connectorRevision: number; readonly connectorVersion: number;
}
export interface PrimaryPortalSigningKeyProof {
  readonly sourceId: typeof PRIMARY_ALPHA_SOURCE_ID;
  readonly keyFingerprints: readonly string[];
}
export type PortalProjectionWriteProof = PortalSourceAuthorityProof | PrimaryPortalSigningKeyProof;
export class PortalSourceAuthorityError extends Error {
  constructor(readonly code: "invalid" | "unavailable" | "credentials_unavailable" | "conflict" | "changed", message = `portal-authority-${code}`) {
    super(message); this.name = "PortalSourceAuthorityError";
  }
}
const invalid = (): never => { throw new PortalSourceAuthorityError("invalid"); };
const scalar = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);
const credentialRef = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const signingKey = z.object({ keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/), value: scalar(8192).min(32) }).strict();
const revisionInput = z.object({ credentialRef, accessIssuer: scalar(2048), accessAudience: scalar(512), accessSubject: scalar(512) }).strict();
const envelopeSchema = z.object({ version: z.literal(1), sets: z.record(credentialRef, z.unknown()) }).strict();
interface Row {
  source_id: string; producer_binding_id: string; snapshot_origin: string; snapshot_base_path: string; application_key: string;
  state: PortalSourceAuthoritySummary["state"]; active_revision: number; version: number; connector_revision: number; connector_version: number;
}
interface RevisionRow {
  credential_ref: string; access_issuer: string; access_audience: string; access_subject: string;
  current_key_id: string; current_key_fingerprint: string; previous_key_id: string | null; previous_key_fingerprint: string | null;
}
function database(env: PortalSourceAuthorityEnvironment): PortalAuthorityDatabase {
  return env.DELIVERY_DB.withSession("first-primary");
}
function secondarySource(value: unknown): string {
  if (typeof value !== "string") return invalid();
  try {
    const source = createCatalogSourceContext(value).sourceId;
    if (source !== PRIMARY_ALPHA_SOURCE_ID) return source;
  } catch { /* convert boundary validation to a safe public code */ }
  return invalid();
}
function exactOrigin(value: string): string {
  try { const url = new URL(value); if (url.protocol === "https:" && url.origin === value && !url.username && !url.password) return value; } catch { /* invalid */ }
  return invalid();
}
function validateConnector(value: PortalAuthorityConnectorIdentity): PortalAuthorityConnectorIdentity {
  secondarySource(value.sourceId); exactOrigin(value.snapshotOrigin);
  if (value.profile !== "business_data" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.producerBindingId)
    || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(value.applicationKey)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.version) || value.version < 1
    || !["pending", "active", "suspended", "retired"].includes(value.state)) return invalid();
  const url = new URL(value.snapshotBasePath, value.snapshotOrigin);
  if (url.origin !== value.snapshotOrigin || url.pathname !== value.snapshotBasePath || url.search || url.hash
    || value.snapshotBasePath.length > 1024 || /[\u0000-\u0020\u007f]/.test(value.snapshotBasePath)) return invalid();
  return value;
}
async function hash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function configuredKeys(env: PortalSourceAuthorityEnvironment, ref: string) {
  try {
    const raw = env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS;
    if (!raw || new TextEncoder().encode(raw).byteLength > 256 * 1024) throw new Error();
    const envelope = envelopeSchema.parse(JSON.parse(raw));
    if (Object.keys(envelope.sets).length > 64) throw new Error();
    const selected = envelope.sets[ref];
    if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new Error();
    const set = selected as Record<string, unknown>;
    const current = signingKey.parse(set.portalCurrent);
    const previous = set.portalPrevious === undefined ? null : signingKey.parse(set.portalPrevious);
    if (previous && (previous.keyId === current.keyId || previous.value === current.value)) throw new Error();
    return { current: { ...current, fingerprint: await hash(current.value) },
      previous: previous ? { ...previous, fingerprint: await hash(previous.value) } : null };
  } catch { throw new PortalSourceAuthorityError("credentials_unavailable"); }
}
function summary(row: Row): PortalSourceAuthoritySummary {
  return { sourceId: row.source_id, producerBindingId: row.producer_binding_id, applicationKey: row.application_key,
    state: row.state, activeRevision: row.active_revision, version: row.version,
    connectorRevision: row.connector_revision, connectorVersion: row.connector_version };
}
function proof(row: Row): PortalSourceAuthorityProof {
  return Object.freeze({ sourceId: row.source_id, revision: row.active_revision, version: row.version,
    connectorRevision: row.connector_revision, connectorVersion: row.connector_version });
}
async function readRow(db: PortalAuthorityDatabase, source: string): Promise<Row | null> {
  return db.prepare("SELECT * FROM pa_portal_source_authorities WHERE source_id=?").bind(source).first<Row>();
}
export async function getPortalSourceAuthority(db: PortalAuthorityDatabase, sourceId: string): Promise<PortalSourceAuthoritySummary | null> {
  const row = await readRow(db, createCatalogSourceContext(sourceId).sourceId);
  return row ? summary(row) : null;
}
export async function portalSourceAuthoritiesReady(db: PortalAuthorityDatabase): Promise<boolean> {
  return (await db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN
    ('pa_portal_source_authorities','pa_portal_source_authority_revisions','pa_portal_source_signing_keys',
     'pa_portal_source_authority_audit','pa_portal_source_write_fences')`).first<number>("n")) === 5;
}
export async function readPortalSourceAuthorityProof(db: PortalAuthorityDatabase, sourceId: string): Promise<PortalSourceAuthorityProof | null> {
  secondarySource(sourceId);
  const row = await db.prepare(`SELECT authority.* FROM pa_portal_source_authorities authority
    JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
    WHERE authority.source_id=? AND authority.state='active'`).bind(sourceId).first<Row>();
  return row ? proof(row) : null;
}
export function portalSourceAuthorityGuard(value: PortalSourceAuthorityProof): { sql: string; bindings: (string | number)[] } {
  secondarySource(value.sourceId);
  if ([value.revision, value.version, value.connectorRevision, value.connectorVersion].some(n => !Number.isSafeInteger(n) || n < 1)) return invalid();
  return { sql: `EXISTS(SELECT 1 FROM pa_portal_source_authorities authority
    JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
    WHERE authority.source_id=? AND authority.state='active' AND authority.active_revision=? AND authority.version=?
      AND authority.connector_revision=? AND authority.connector_version=?)`,
  bindings: [value.sourceId, value.revision, value.version, value.connectorRevision, value.connectorVersion] };
}
function fence(db: PortalAuthorityDatabase, source: string, sql: string, bindings: (string | number)[]) {
  return db.prepare(`INSERT INTO pa_portal_source_write_fences(source_id,write_guard) VALUES(?,CASE WHEN ${sql} THEN 1 ELSE 0 END)
    ON CONFLICT(source_id) DO UPDATE SET write_guard=excluded.write_guard`).bind(source, ...bindings);
}
export function portalSourceAuthorityFence(db: PortalAuthorityDatabase, value: PortalSourceAuthorityProof): D1PreparedStatement {
  const guard = portalSourceAuthorityGuard(value); return fence(db, value.sourceId, guard.sql, guard.bindings);
}
function primaryKeyGuard(value: PrimaryPortalSigningKeyProof) {
  if (value.sourceId !== PRIMARY_ALPHA_SOURCE_ID || !Array.isArray(value.keyFingerprints) || !value.keyFingerprints.length
    || value.keyFingerprints.length > 2 || value.keyFingerprints.some(key => !/^[a-f0-9]{64}$/.test(key))
    || new Set(value.keyFingerprints).size !== value.keyFingerprints.length) return invalid();
  return { sql: `(SELECT count(*) FROM pa_portal_source_signing_keys WHERE source_id=?
    AND fingerprint IN (SELECT value FROM json_each(?)))=?`, bindings: [PRIMARY_ALPHA_SOURCE_ID, JSON.stringify(value.keyFingerprints), value.keyFingerprints.length] };
}
export function portalProjectionSourceFence(db: PortalAuthorityDatabase, value: PortalProjectionWriteProof): D1PreparedStatement {
  if (!("keyFingerprints" in value)) return portalSourceAuthorityFence(db, value);
  const guard = primaryKeyGuard(value); return fence(db, value.sourceId, guard.sql, guard.bindings);
}
export async function assertPortalProjectionSourceProof(db: PortalAuthorityDatabase, value: PortalProjectionWriteProof): Promise<void> {
  if (!("keyFingerprints" in value)) return assertPortalSourceAuthorityProof(db, value);
  const guard = primaryKeyGuard(value);
  if ((await db.prepare(`SELECT ${guard.sql} ok`).bind(...guard.bindings).first<number>("ok")) !== 1)
    throw new PortalSourceAuthorityError("changed");
}
/** The existing primary wire protocol stays unchanged. On pre-0162 schemas
 * only the exact absent-table case keeps legacy behavior; partial or broken
 * authority metadata fails closed. Trusted scalar keys never change owner. */
export async function reservePrimaryPortalSigningKeys(env: PortalSourceAuthorityEnvironment): Promise<PrimaryPortalSigningKeyProof | null> {
  const db = database(env);
  const tableCount = await db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN
    ('pa_portal_source_authorities','pa_portal_source_authority_revisions','pa_portal_source_signing_keys',
     'pa_portal_source_authority_audit','pa_portal_source_write_fences')`).first<number>("n");
  if (tableCount === 0) return null;
  if (tableCount !== 5) throw new PortalSourceAuthorityError("unavailable");
  if (typeof env.PROJECT_ALPHA_PORTAL_HMAC_SECRET !== "string" || env.PROJECT_ALPHA_PORTAL_HMAC_SECRET.length < 32)
    throw new PortalSourceAuthorityError("credentials_unavailable");
  const configured = [env.PROJECT_ALPHA_PORTAL_HMAC_SECRET, env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET]
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= 32);
  const fingerprints = [...new Set(await Promise.all(configured.map(hash)))];
  const statements: D1PreparedStatement[] = [];
  for (const fingerprint of fingerprints) {
    statements.push(fence(db, PRIMARY_ALPHA_SOURCE_ID, "NOT EXISTS(SELECT 1 FROM pa_portal_source_signing_keys WHERE fingerprint=? AND source_id<>?)", [fingerprint, PRIMARY_ALPHA_SOURCE_ID]));
    statements.push(db.prepare(`INSERT INTO pa_portal_source_signing_keys(fingerprint,source_id)
      SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM pa_portal_source_signing_keys WHERE fingerprint=?)`).bind(fingerprint, PRIMARY_ALPHA_SOURCE_ID, fingerprint));
  }
  try { await db.batch(statements); } catch (error) { changed(error); }
  return Object.freeze({ sourceId: PRIMARY_ALPHA_SOURCE_ID, keyFingerprints: Object.freeze(fingerprints) });
}
export async function assertPortalSourceAuthorityProof(db: PortalAuthorityDatabase, value: PortalSourceAuthorityProof): Promise<void> {
  const guard = portalSourceAuthorityGuard(value);
  if ((await db.prepare(`SELECT ${guard.sql} ok`).bind(...guard.bindings).first<number>("ok")) !== 1)
    throw new PortalSourceAuthorityError("changed");
}
/** Fixed internal SQL expressions only. This is availability, not membership. */
export function portalSourceReadableSql(sourceExpression: string): string {
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(sourceExpression)) return invalid();
  return `(${sourceExpression}='${PRIMARY_ALPHA_SOURCE_ID}' OR EXISTS(SELECT 1 FROM pa_portal_source_authorities portal_authority
    JOIN pa_portal_source_authority_revisions portal_revision ON portal_revision.source_id=portal_authority.source_id
      AND portal_revision.revision=portal_authority.active_revision
    WHERE portal_authority.source_id=${sourceExpression} AND portal_authority.state='active'))`;
}
function sameIdentity(row: Row, connector: PortalAuthorityConnectorIdentity): boolean {
  return row.source_id === connector.sourceId && row.producer_binding_id === connector.producerBindingId
    && row.snapshot_origin === connector.snapshotOrigin && row.snapshot_base_path === connector.snapshotBasePath
    && row.application_key === connector.applicationKey;
}
function actor(value: string): string { if (!scalar(256).safeParse(value).success) return invalid(); return value; }
function audit(db: PortalAuthorityDatabase, source: string, version: number, revision: number, action: string, actorId: string) {
  return db.prepare("INSERT INTO pa_portal_source_authority_audit(id,source_id,version,revision,action,actor_id) VALUES(?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), source, version, revision, action, actor(actorId));
}
function changed(error: unknown): never {
  if (error instanceof Error && /pa_portal_source_write_guard|portal-authority|portal-signing-key|UNIQUE constraint/.test(error.message))
    throw new PortalSourceAuthorityError("conflict");
  throw error;
}
/** Existing connector admin owns the external Ops proof/barrier. Configuration
 * is intentionally staged pending; this function never enables a producer. */
export async function provisionPortalSourceAuthority(env: PortalSourceAuthorityEnvironment, connectorValue: PortalAuthorityConnectorIdentity,
  inputValue: PortalAuthorityRevisionInput, expectedVersion: number | null, actorId: string): Promise<PortalSourceAuthoritySummary> {
  const connector = validateConnector(connectorValue);
  const parsed = revisionInput.safeParse(inputValue); if (!parsed.success) return invalid();
  const input = parsed.data; exactOrigin(input.accessIssuer);
  if (connector.state === "retired" || (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))) return invalid();
  const keys = await configuredKeys(env, input.credentialRef);
  const db = database(env), old = await readRow(db, connector.sourceId);
  if ((old?.version ?? null) !== expectedVersion || (old && (!sameIdentity(old, connector) || old.state === "retired")))
    throw new PortalSourceAuthorityError("conflict");
  const version = (old?.version ?? 0) + 1, revision = (old?.active_revision ?? 0) + 1;
  const reservations = [{ source: connector.sourceId, fingerprint: keys.current.fingerprint },
    ...(keys.previous ? [{ source: connector.sourceId, fingerprint: keys.previous.fingerprint }] : [])];
  for (const secret of [env.PROJECT_ALPHA_PORTAL_HMAC_SECRET, env.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET]) {
    if (typeof secret === "string" && secret.length >= 32) reservations.push({ source: PRIMARY_ALPHA_SOURCE_ID, fingerprint: await hash(secret) });
  }
  const guard = old ? "EXISTS(SELECT 1 FROM pa_portal_source_authorities WHERE source_id=? AND version=? AND state<>'retired')"
    : "NOT EXISTS(SELECT 1 FROM pa_portal_source_authorities WHERE source_id=?)";
  const statements = [fence(db, connector.sourceId, guard, old ? [connector.sourceId, old.version] : [connector.sourceId])];
  for (const key of reservations) {
    statements.push(fence(db, connector.sourceId, "NOT EXISTS(SELECT 1 FROM pa_portal_source_signing_keys WHERE fingerprint=? AND source_id<>?)", [key.fingerprint, key.source]));
    statements.push(db.prepare(`INSERT INTO pa_portal_source_signing_keys(fingerprint,source_id)
      SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM pa_portal_source_signing_keys WHERE fingerprint=?)`).bind(key.fingerprint, key.source, key.fingerprint));
  }
  if (!old) statements.push(db.prepare(`INSERT INTO pa_portal_source_authorities
    (source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,state,active_revision,version,connector_revision,connector_version)
    VALUES(?,?,?,?,?,'pending',?,?,?,?)`).bind(connector.sourceId, connector.producerBindingId, connector.snapshotOrigin,
    connector.snapshotBasePath, connector.applicationKey, revision, version, connector.revision, connector.version));
  statements.push(db.prepare(`INSERT INTO pa_portal_source_authority_revisions
    (source_id,revision,credential_ref,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,previous_key_id,previous_key_fingerprint,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(connector.sourceId, revision, input.credentialRef, input.accessIssuer, input.accessAudience,
    input.accessSubject, keys.current.keyId, keys.current.fingerprint, keys.previous?.keyId ?? null, keys.previous?.fingerprint ?? null, actor(actorId)));
  if (old) statements.push(db.prepare(`UPDATE pa_portal_source_authorities SET state='pending',active_revision=?,version=?,
    connector_revision=?,connector_version=?,updated_at=datetime('now') WHERE source_id=? AND version=?`)
    .bind(revision, version, connector.revision, connector.version, connector.sourceId, old.version));
  statements.push(audit(db, connector.sourceId, version, revision, "provision", actorId));
  try { await db.batch(statements); } catch (error) { changed(error); }
  const current = await readRow(db, connector.sourceId);
  if (!current || current.version !== version) throw new PortalSourceAuthorityError("changed");
  return summary(current);
}
export async function setPortalSourceAuthorityState(env: PortalSourceAuthorityEnvironment, connectorValue: PortalAuthorityConnectorIdentity,
  expectedVersion: number, state: "active" | "suspended" | "retired", actorId: string): Promise<PortalSourceAuthoritySummary> {
  const connector = validateConnector(connectorValue), db = database(env), old = await readRow(db, connector.sourceId);
  if (!["active", "suspended", "retired"].includes(state) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalid();
  if (!old || old.version !== expectedVersion || !sameIdentity(old, connector) || old.state === "retired") throw new PortalSourceAuthorityError("conflict");
  if (state === "active") {
    if (connector.state !== "active") throw new PortalSourceAuthorityError("unavailable");
    if (old.connector_revision !== connector.revision) throw new PortalSourceAuthorityError("conflict");
    await resolveConfiguredRevision(env, db, old);
  }
  const version = old.version + 1;
  try { await db.batch([
    fence(db, connector.sourceId, "EXISTS(SELECT 1 FROM pa_portal_source_authorities WHERE source_id=? AND version=? AND state<>'retired')", [connector.sourceId, expectedVersion]),
    db.prepare(`UPDATE pa_portal_source_authorities SET state=?,version=?,connector_revision=?,connector_version=?,updated_at=datetime('now')
      WHERE source_id=? AND version=?`).bind(state, version, old.connector_revision, connector.version, connector.sourceId, expectedVersion),
    audit(db, connector.sourceId, version, old.active_revision, state, actorId),
  ]); } catch (error) { changed(error); }
  const current = await readRow(db, connector.sourceId);
  if (!current || current.version !== version) throw new PortalSourceAuthorityError("changed");
  return summary(current);
}
async function resolveConfiguredRevision(env: PortalSourceAuthorityEnvironment, db: PortalAuthorityDatabase, row: Row) {
  const revision = await db.prepare("SELECT * FROM pa_portal_source_authority_revisions WHERE source_id=? AND revision=?")
    .bind(row.source_id, row.active_revision).first<RevisionRow>();
  if (!revision) throw new PortalSourceAuthorityError("unavailable");
  const keys = await configuredKeys(env, revision.credential_ref);
  if (keys.current.keyId !== revision.current_key_id || keys.current.fingerprint !== revision.current_key_fingerprint
    || (keys.previous?.keyId ?? null) !== revision.previous_key_id || (keys.previous?.fingerprint ?? null) !== revision.previous_key_fingerprint)
    throw new PortalSourceAuthorityError("credentials_unavailable");
  return { applicationKey: row.application_key, accessIssuer: revision.access_issuer, accessAudience: revision.access_audience,
    accessSubject: revision.access_subject, ...keys };
}
export async function resolvePortalSourceAuthority(env: PortalSourceAuthorityEnvironment, sourceId: string) {
  const db = database(env), row = await readRow(db, secondarySource(sourceId));
  if (!row || row.state !== "active") throw new PortalSourceAuthorityError("unavailable");
  const credentials = await resolveConfiguredRevision(env, db, row);
  await assertPortalSourceAuthorityProof(db, proof(row));
  return { proof: proof(row), ...credentials };
}
