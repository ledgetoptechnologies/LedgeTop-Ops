import { z } from "zod";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { createProjectAlphaSourceContext, type ProjectAlphaSourceContext } from "./project-alpha-source";

type RegistryDatabase = Pick<D1Database, "prepare" | "batch">;
export interface ProjectAlphaConnectorEnvironment {
  OPS_DB: D1Database;
  /** Deploy-managed secret JSON. Never accepted in an administration request. */
  PROJECT_ALPHA_CONNECTOR_CREDENTIALS?: string;
  PROJECT_ALPHA_BASE_URL?: string;
  PROJECT_ALPHA_API_KEY?: string;
  PROJECT_ALPHA_DRAFT_QUOTE_API_KEY?: string;
  PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET?: string;
  APPLICATION_KEY?: string;
  TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY?: string;
  PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY?: string;
  PROJECT_ALPHA_WEBHOOK_HMAC_SECRET?: string;
  PROJECT_ALPHA_ALLOW_LEGACY_HMAC?: string;
}
export type ProjectAlphaConnectorProfile = "primary_legacy" | "business_data";
export type ProjectAlphaConnectorState = "pending" | "active" | "suspended" | "retired";
export interface ProjectAlphaConnectorProof {
  readonly mode: "registry" | "legacy_primary";
  readonly sourceId: string;
  readonly revision: number;
  readonly version: number;
  readonly profile: ProjectAlphaConnectorProfile;
  /** Internal scheduler claim only; never a wire/header/body credential. */
  readonly scheduledRecovery?: {
    readonly attemptId:string; readonly schedulerToken:string; readonly leaseToken:string;
    readonly primaryRevision:number; readonly primaryVersion:number; readonly deadlineAt:number;
  };
}
export interface ConnectorSigningKey {
  readonly keyId: string;
  readonly algorithm: "ed25519" | "hmac-sha256";
  readonly value: string;
  readonly fingerprint: string;
}
export interface ResolvedProjectAlphaConnector {
  readonly source: ProjectAlphaSourceContext;
  /** Configuration proof only. An inbound request must still authenticate. */
  readonly proof: ProjectAlphaConnectorProof;
  readonly snapshot: { baseUrl: string; apiKey: string; applicationKey: string } | null;
  readonly event: { applicationKey: string; accessIssuer: string; accessAudience: string; accessSubject: string | null;
    current: ConnectorSigningKey; previous: ConnectorSigningKey | null } | null;
  /** Outbound draft creation has its own credential pair. Snapshot, event and
   * portal credentials are deliberately not valid substitutes. */
  readonly draftQuote: { baseUrl: string; applicationKey: string; apiKey: string; hmacSecret: string } | null;
}
export interface ProjectAlphaConnectorSummary {
  sourceId: string; producerBindingId: string; snapshotOrigin: string; snapshotBasePath: string;
  applicationKey: string; profile: ProjectAlphaConnectorProfile; displayName: string;
  state: ProjectAlphaConnectorState; readVisible: boolean; activeRevision: number; version: number;
}
export interface ProjectAlphaConnectorRevisionInput {
  credentialRef: string; snapshotBasePath: string; accessIssuer: string; accessAudience: string; accessSubject: string;
}
/** Pending is the initial enrollment state only; enrolled connections never
 * return to it because that would revive the deployment-wide scalar adapter. */
export function assertProjectAlphaConnectorStateTransition(current: ProjectAlphaConnectorState,
  next: ProjectAlphaConnectorState): void {
  if (current === "retired" && next !== "retired")
    fail("conflict", "A retired connector cannot be reactivated");
  if (next === "pending" && current !== "pending")
    fail("conflict", "An enrolled connector cannot return to pending");
}
export interface RegisterProjectAlphaConnectorInput {
  sourceId: string; producerBindingId: string; snapshotOrigin: string; applicationKey: string;
  profile: ProjectAlphaConnectorProfile; displayName: string; revision: ProjectAlphaConnectorRevisionInput;
}
export type PrimaryConnectorPreflightReasonCode =
  | "primary_already_registered"
  | "primary_snapshot_configuration_missing"
  | "connector_credentials_unavailable"
  | "primary_destination_mismatch"
  | "primary_signing_identity_unattested";
export interface PrimaryConnectorPreflight {
  ready: boolean;
  sourceId: typeof PRIMARY_ALPHA_SOURCE_ID;
  profile: "primary_legacy";
  expected: { snapshotOrigin: string | null; snapshotBasePath: string | null; applicationKey: string | null };
  reasons: Array<{ code: PrimaryConnectorPreflightReasonCode; message: string }>;
}
export class ProjectAlphaConnectorError extends Error {
  constructor(readonly code: "invalid" | "unavailable" | "conflict" | "credentials_unavailable" | "capacity" | "changed", message: string) {
    super(message); this.name = "ProjectAlphaConnectorError";
  }
}
const fail = (code: ProjectAlphaConnectorError["code"], message: string): never => { throw new ProjectAlphaConnectorError(code, message); };
const MAX_CONNECTORS = 32;
// Deployment can stage a new reference for every producer before retiring its
// previous reference. This does not increase the durable connector limit.
const MAX_CREDENTIAL_REFERENCES = MAX_CONNECTORS * 2;
const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const scalar = (max: number) => z.string().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/);
const signingSchema = z.object({ keyId: safeId, algorithm: z.enum(["ed25519", "hmac-sha256"]), value: scalar(8192) }).strict();
const draftQuoteSchema = z.object({ apiKey: scalar(8192), hmacSecret: scalar(8192).refine(value => value.length >= 32) }).strict();
// Portal keys are validated only by the separately enabled portal purpose.
const credentialSchema = z.object({ snapshotApiKey: scalar(8192), eventCurrent: signingSchema, eventPrevious: signingSchema.optional(),
  portalCurrent: z.unknown().optional(), portalPrevious: z.unknown().optional(), draftQuote: draftQuoteSchema.optional() }).strict();
const credentialsSchema = z.object({ version: z.literal(1), sets: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.unknown()) }).strict();
type KeyInput = z.infer<typeof signingSchema>;
const revisionSchema = z.object({ credentialRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), snapshotBasePath: scalar(1024),
  accessIssuer: scalar(2048), accessAudience: scalar(512), accessSubject: scalar(512) }).strict();
const registrationSchema = z.object({ sourceId: scalar(78), producerBindingId: safeId, snapshotOrigin: scalar(2048),
  applicationKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/), profile: z.enum(["primary_legacy", "business_data"]),
  displayName: scalar(160).refine(value => value.trim() === value), revision: revisionSchema }).strict();

interface ConnectorRow {
  source_id: string; producer_binding_id: string; snapshot_origin: string; snapshot_base_path: string; application_key: string;
  profile: ProjectAlphaConnectorProfile; display_name: string; state: ProjectAlphaConnectorState;
  read_visible: number; active_revision: number; version: number;
}
interface RevisionRow {
  source_id: string; revision: number; credential_ref: string; snapshot_base_path: string;
  access_issuer: string; access_audience: string; access_subject: string;
  current_key_id: string; current_key_fingerprint: string; previous_key_id: string | null; previous_key_fingerprint: string | null;
  draft_quote_api_key_fingerprint: string | null; draft_quote_hmac_fingerprint: string | null;
}
function database(env: ProjectAlphaConnectorEnvironment): RegistryDatabase { return env.OPS_DB.withSession("first-primary"); }
function sourceId(value: unknown): string {
  try { return createProjectAlphaSourceContext(value).sourceId; } catch { return fail("invalid", "Connector source is invalid"); }
}
function origin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.search || url.hash) throw new Error();
    return value;
  } catch { return fail("invalid", "Connector origin must be an exact HTTPS origin"); }
}
function basePath(value: string): string {
  try {
    const url = new URL(value, "https://connector.invalid");
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || url.pathname !== value || url.search || url.hash
      || (value !== "/" && value.endsWith("/"))) throw new Error();
    return value;
  } catch { return fail("invalid", "Connector base path must be canonical"); }
}
function actor(value: string): string {
  const parsed = scalar(256).safeParse(value);
  if (!parsed.success) return fail("invalid", "Connector actor is invalid");
  return parsed.data;
}
function parseRevision(value: ProjectAlphaConnectorRevisionInput): ProjectAlphaConnectorRevisionInput {
  const parsed = revisionSchema.safeParse(value);
  if (!parsed.success) return fail("invalid", "Connector revision is invalid");
  return { ...parsed.data, snapshotBasePath: basePath(parsed.data.snapshotBasePath), accessIssuer: origin(parsed.data.accessIssuer) };
}
function secrets(env: ProjectAlphaConnectorEnvironment): Record<string, unknown> {
  const raw = env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS;
  if (typeof raw !== "string" || !raw || new TextEncoder().encode(raw).byteLength > 256 * 1024) return fail("credentials_unavailable", "Connector credentials are not configured");
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success || Object.keys(parsed.data.sets).length > MAX_CREDENTIAL_REFERENCES) throw new Error();
    return parsed.data.sets;
  } catch { return fail("credentials_unavailable", "Connector credential configuration is invalid"); }
}
function keyBytes(value: KeyInput, legacy = false): Uint8Array {
  if (value.algorithm === "hmac-sha256") {
    if (value.value.length < (legacy ? 1 : 32) || value.value.length > 8192) return fail("credentials_unavailable", "Connector signing key is invalid");
    return new TextEncoder().encode(value.value);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.value)) return fail("credentials_unavailable", "Connector signing key is invalid");
  try {
    const bytes = Uint8Array.from(atob(`${value.value.replace(/-/g, "+").replace(/_/g, "/")}=`), ch => ch.charCodeAt(0));
    if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== value.value) throw new Error();
    return bytes;
  } catch { return fail("credentials_unavailable", "Connector signing key is invalid"); }
}
async function signingKey(value: KeyInput, legacy = false): Promise<ConnectorSigningKey> {
  // Fingerprint decoded key material, not its textual encoding. Include the
  // algorithm domain; an Ed25519 verification key is not an HMAC credential.
  const prefix = new TextEncoder().encode(`${value.algorithm}\0`), bytes = keyBytes(value, legacy);
  const combined = new Uint8Array(prefix.length + bytes.length); combined.set(prefix); combined.set(bytes, prefix.length);
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", combined))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return Object.freeze({ ...value, fingerprint });
}
async function credentialFingerprint(domain: string, value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${domain}\0${value}`)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
interface DraftQuoteCredentialReservation {
  purpose: "api_key" | "hmac";
  purposeFingerprint: string;
  ownershipFingerprint: string;
}
async function legacyKeys(env: ProjectAlphaConnectorEnvironment): Promise<ConnectorSigningKey[]> {
  const inputs: KeyInput[] = [];
  if (env.PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY) inputs.push({ keyId: "legacy-current", algorithm: "ed25519", value: env.PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY });
  if (env.PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY) inputs.push({ keyId: "legacy-previous", algorithm: "ed25519", value: env.PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY });
  // Reserve supplied legacy HMAC even when legacy verification is currently off;
  // turning a verifier off is not permission to reassign its old signing key.
  if (env.PROJECT_ALPHA_WEBHOOK_HMAC_SECRET) inputs.push({ keyId: "legacy-hmac", algorithm: "hmac-sha256", value: env.PROJECT_ALPHA_WEBHOOK_HMAC_SECRET });
  return Promise.all(inputs.map(input => signingKey(input, true)));
}
async function configuredKeys(env: ProjectAlphaConnectorEnvironment, ref: string, profile: ProjectAlphaConnectorProfile) {
  const configured = secrets(env);
  if (!Object.hasOwn(configured, ref)) return fail("credentials_unavailable", "The connector credential set is missing");
  // A malformed unrelated producer must not disable this producer. The shared
  // envelope is bounded above; only the selected reference is credential data.
  const parsed = credentialSchema.safeParse(configured[ref]);
  if (!parsed.success) return fail("credentials_unavailable", "The connector credential set is invalid");
  const set = parsed.data;
  const current = await signingKey(set.eventCurrent), previous = set.eventPrevious ? await signingKey(set.eventPrevious) : null;
  if (previous && (current.keyId === previous.keyId || current.fingerprint === previous.fingerprint)) return fail("credentials_unavailable", "Connector rotation keys must be distinct");
  if (profile === "business_data" && (current.algorithm !== "ed25519" || (previous && previous.algorithm !== "ed25519")))
    return fail("credentials_unavailable", "Business connectors require Ed25519 signing keys");
  if (set.draftQuote) {
    const reserved = new Set<string>([set.snapshotApiKey, set.eventCurrent.value, ...(set.eventPrevious ? [set.eventPrevious.value] : [])]);
    for (const portal of [set.portalCurrent, set.portalPrevious]) {
      if (portal && typeof portal === "object" && !Array.isArray(portal)) {
        const value = (portal as Record<string, unknown>).value;
        if (typeof value === "string") reserved.add(value);
      }
    }
    if (set.draftQuote.apiKey === set.draftQuote.hmacSecret || reserved.has(set.draftQuote.apiKey) || reserved.has(set.draftQuote.hmacSecret))
      return fail("credentials_unavailable", "Draft quote credentials must be dedicated to that purpose");
    if ([env.PROJECT_ALPHA_API_KEY, env.PROJECT_ALPHA_WEBHOOK_HMAC_SECRET,
      env.PROJECT_ALPHA_DRAFT_QUOTE_API_KEY, env.PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET]
      .some(value => typeof value === "string" && (value === set.draftQuote!.apiKey || value === set.draftQuote!.hmacSecret)))
      return fail("conflict", "A draft quote credential belongs to the primary connection");
  }
  const draftQuoteFingerprints = set.draftQuote ? {
    apiKey: await credentialFingerprint("draft-quote-api-key", set.draftQuote.apiKey),
    hmac: await credentialFingerprint("draft-quote-hmac", set.draftQuote.hmacSecret),
  } : null;
  const draftQuoteReservations: DraftQuoteCredentialReservation[] = set.draftQuote && draftQuoteFingerprints ? [
    { purpose: "api_key", purposeFingerprint: draftQuoteFingerprints.apiKey,
      ownershipFingerprint: await credentialFingerprint("draft-quote-credential", set.draftQuote.apiKey) },
    { purpose: "hmac", purposeFingerprint: draftQuoteFingerprints.hmac,
      ownershipFingerprint: await credentialFingerprint("draft-quote-credential", set.draftQuote.hmacSecret) },
  ] : [];
  return { set, current, previous, draftQuoteFingerprints, draftQuoteReservations };
}
async function pinPrimaryEnrollment(env: ProjectAlphaConnectorEnvironment, value: RegisterProjectAlphaConnectorInput,
  current: ConnectorSigningKey, previous: ConnectorSigningKey | null): Promise<void> {
  let url: URL;
  try {
    if (!env.PROJECT_ALPHA_BASE_URL || !env.APPLICATION_KEY || !env.PROJECT_ALPHA_API_KEY?.trim()) throw new Error();
    url = new URL(env.PROJECT_ALPHA_BASE_URL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { return fail("credentials_unavailable", "Existing primary snapshot ownership must be configured before enrollment"); }
  if (value.snapshotOrigin !== url.origin || value.revision.snapshotBasePath !== (url.pathname.replace(/\/+$/, "") || "/")
    || value.applicationKey !== env.APPLICATION_KEY?.trim().toLowerCase()) fail("conflict", "Primary enrollment must preserve the existing producer destination");
  const local = await legacyKeys(env);
  const reserved = (await database(env).prepare(`SELECT fingerprint,algorithm FROM pa_connector_signing_keys
    WHERE source_id=? LIMIT ?`).bind(PRIMARY_ALPHA_SOURCE_ID, 8).all<{ fingerprint: string; algorithm: ConnectorSigningKey["algorithm"] }>()).results;
  // Ops Sync owns the legacy webhook secret and records only its fingerprint
  // in the shared registry. Operations may use that durable attestation rather
  // than receiving a second copy of the webhook credential.
  const known = new Map([...local.map(key => [key.fingerprint, key.algorithm] as const),
    ...reserved.map(key => [key.fingerprint, key.algorithm] as const)]);
  if (!known.size || [current, ...(previous ? [previous] : [])]
    .some(key => known.get(key.fingerprint) !== key.algorithm))
    fail("credentials_unavailable", "Primary enrollment requires its already configured signing identity");
}

/** Read-only readiness proof for a proposed primary enrollment. It evaluates
 * deploy-managed secrets internally but returns only bounded reason codes and
 * the non-secret destination already configured for the scalar adapter. */
export async function preflightPrimaryProjectAlphaConnector(env: ProjectAlphaConnectorEnvironment,
  input: RegisterProjectAlphaConnectorInput): Promise<PrimaryConnectorPreflight> {
  let expected: PrimaryConnectorPreflight["expected"] = { snapshotOrigin: null, snapshotBasePath: null, applicationKey: null };
  try {
    if (env.PROJECT_ALPHA_BASE_URL) {
      const url = new URL(env.PROJECT_ALPHA_BASE_URL);
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) expected = {
        snapshotOrigin: url.origin,
        snapshotBasePath: url.pathname.replace(/\/+$/, "") || "/",
        applicationKey: env.APPLICATION_KEY?.trim().toLowerCase() || null,
      };
    }
  } catch { /* A bounded reason below represents malformed deployment state. */ }
  const result = (reasons: PrimaryConnectorPreflight["reasons"]): PrimaryConnectorPreflight => ({
    ready: reasons.length === 0, sourceId: PRIMARY_ALPHA_SOURCE_ID, profile: "primary_legacy", expected, reasons,
  });
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success || parsed.data.sourceId !== PRIMARY_ALPHA_SOURCE_ID || parsed.data.profile !== "primary_legacy")
    return result([{ code: "primary_destination_mismatch", message: "Enter the exact primary source and authority profile." }]);
  const value = parsed.data;
  let revision: ProjectAlphaConnectorRevisionInput, snapshotOrigin: string;
  try { revision = parseRevision(value.revision); snapshotOrigin = origin(value.snapshotOrigin); }
  catch { return result([{ code: "primary_destination_mismatch", message: "The proposed primary connection metadata is invalid." }]); }
  if (await read(database(env), PRIMARY_ALPHA_SOURCE_ID)) return result([{
    code: "primary_already_registered", message: "The primary exact-source connection is already registered.",
  }]);
  if (!expected.snapshotOrigin || !expected.snapshotBasePath || !expected.applicationKey || !env.PROJECT_ALPHA_API_KEY?.trim())
    return result([{ code: "primary_snapshot_configuration_missing", message: "The existing primary snapshot configuration is incomplete." }]);
  let keys: Awaited<ReturnType<typeof configuredKeys>>;
  try { keys = await configuredKeys(env, revision.credentialRef, value.profile); }
  catch {
    return result([{ code: "connector_credentials_unavailable", message: "The selected deploy-managed credential reference is unavailable or invalid." }]);
  }
  try { await pinPrimaryEnrollment(env, { ...value, snapshotOrigin, revision }, keys.current, keys.previous); }
  catch (error) {
    if (error instanceof ProjectAlphaConnectorError && error.code === "conflict") return result([{
      code: "primary_destination_mismatch", message: "The proposed destination does not match the existing primary connection.",
    }]);
    return result([{ code: "primary_signing_identity_unattested", message: "The selected signing identity has not been attested for the existing primary producer.",
    }]);
  }
  return result([]);
}
function summary(row: ConnectorRow): ProjectAlphaConnectorSummary {
  return { sourceId: row.source_id, producerBindingId: row.producer_binding_id, snapshotOrigin: row.snapshot_origin,
    snapshotBasePath: row.snapshot_base_path, applicationKey: row.application_key, profile: row.profile, displayName: row.display_name,
    state: row.state, readVisible: row.read_visible === 1, activeRevision: row.active_revision, version: row.version };
}
async function read(db: RegistryDatabase, id: string): Promise<ConnectorRow | null> {
  return db.prepare("SELECT * FROM pa_connectors WHERE source_id=?").bind(id).first<ConnectorRow>();
}
function proof(row: ConnectorRow): ProjectAlphaConnectorProof {
  return Object.freeze({ mode: "registry", sourceId: row.source_id, profile: row.profile, revision: row.active_revision, version: row.version });
}
function validProof(value: ProjectAlphaConnectorProof): void {
  sourceId(value.sourceId);
  if ((value.profile === "primary_legacy") !== (value.sourceId === PRIMARY_ALPHA_SOURCE_ID)
    || !["primary_legacy", "business_data"].includes(value.profile)
    || (value.mode !== "registry" && value.mode !== "legacy_primary")
    || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.version)
    || (value.mode === "registry" ? value.revision < 1 || value.version < 1
      : value.sourceId !== PRIMARY_ALPHA_SOURCE_ID || value.revision !== 0 || value.version !== 0)) fail("invalid", "Connector proof is invalid");
  const scheduled=value.scheduledRecovery;
  if(scheduled && (value.mode!=="registry" || value.profile!=="business_data"
    || ![scheduled.attemptId,scheduled.schedulerToken,scheduled.leaseToken].every(id=>typeof id==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    || ![scheduled.primaryRevision,scheduled.primaryVersion,scheduled.deadlineAt].every(number=>Number.isSafeInteger(number)&&number>0)))
    fail("invalid","Scheduled connector proof is invalid");
}
export function connectorFenceSql(value: ProjectAlphaConnectorProof): { sql: string; bindings: (string | number)[] } {
  validProof(value);
  if (value.mode === "legacy_primary") return {
    // A pending primary row is only a staged enrollment. Keep the already
    // deployed scalar adapter live until activation commits the handoff. A
    // concurrent activation makes this fence fail in the same write batch.
    sql: "NOT EXISTS(SELECT 1 FROM pa_connectors WHERE source_id=? AND state<>'pending')",
    bindings: [PRIMARY_ALPHA_SOURCE_ID],
  };
  const result = { sql: `EXISTS(SELECT 1 FROM pa_connectors connector WHERE connector.source_id=? AND connector.state='active'
    AND connector.active_revision=? AND connector.version=? AND connector.profile=?
    AND (connector.source_id='project-alpha:primary' OR EXISTS(SELECT 1 FROM pa_connectors primary_source
      WHERE primary_source.source_id='project-alpha:primary' AND primary_source.state='active')))`,
  bindings: [value.sourceId, value.revision, value.version, value.profile] as (string|number)[] };
  const scheduled=value.scheduledRecovery;
  if(scheduled){
    result.sql+=` AND EXISTS(SELECT 1 FROM pa_connectors primary_source WHERE source_id='project-alpha:primary'
      AND state='active' AND active_revision=? AND version=?)
      AND EXISTS(SELECT 1 FROM pa_snapshot_recovery_scheduler WHERE id='secondary' AND lease_token=? AND lease_until>unixepoch('now')*1000)
      AND EXISTS(SELECT 1 FROM pa_snapshot_recovery_sources source JOIN pa_snapshot_recovery_attempts attempt
        ON attempt.id=source.attempt_id AND attempt.source_id=source.source_id
        WHERE source.source_id=? AND source.status='running' AND source.attempt_id=? AND source.lease_token=?
          AND source.lease_until>unixepoch('now')*1000 AND attempt.status='running'
          AND attempt.scheduler_token=? AND attempt.source_revision=? AND attempt.source_version=?
          AND attempt.primary_revision=? AND attempt.primary_version=? AND attempt.deadline_at=?
          AND attempt.deadline_at>unixepoch('now')*1000)`;
    result.bindings.push(scheduled.primaryRevision,scheduled.primaryVersion,scheduled.schedulerToken,value.sourceId,
      scheduled.attemptId,scheduled.leaseToken,scheduled.schedulerToken,value.revision,value.version,
      scheduled.primaryRevision,scheduled.primaryVersion,scheduled.deadlineAt);
  }
  return result;
}
function fence(db: RegistryDatabase, id: string, sql: string, bindings: (string | number)[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO pa_connector_write_fences(source_id,write_guard)
    VALUES(?,CASE WHEN ${sql} THEN 1 ELSE 0 END)
    ON CONFLICT(source_id) DO UPDATE SET write_guard=excluded.write_guard`).bind(id, ...bindings);
}
/** Prepend to the same batch as writes. A SELECT returning no rows is not a fence. */
export function connectorFenceStatement(db: RegistryDatabase, value: ProjectAlphaConnectorProof): D1PreparedStatement {
  const guard = connectorFenceSql(value); return fence(db, value.sourceId, guard.sql, guard.bindings);
}
export async function assertProjectAlphaConnectorProof(env: ProjectAlphaConnectorEnvironment, value: ProjectAlphaConnectorProof): Promise<void> {
  const guard = connectorFenceSql(value);
  if (!await database(env).prepare(`SELECT 1 ok WHERE ${guard.sql}`).bind(...guard.bindings).first()) fail("changed", "Connector configuration changed");
}
async function verifiedConfiguration(env: ProjectAlphaConnectorEnvironment, row: ConnectorRow) {
  const db = database(env);
  const revision = await db.prepare("SELECT * FROM pa_connector_revisions WHERE source_id=? AND revision=?")
    .bind(row.source_id, row.active_revision).first<RevisionRow>();
  if (!revision) return fail("unavailable", "Connector revision is unavailable");
  const keys = await configuredKeys(env, revision.credential_ref, row.profile);
  if (keys.current.keyId !== revision.current_key_id || keys.current.fingerprint !== revision.current_key_fingerprint
    || (keys.previous?.keyId ?? null) !== revision.previous_key_id || (keys.previous?.fingerprint ?? null) !== revision.previous_key_fingerprint)
    return fail("credentials_unavailable", "Connector signing configuration does not match its enrolled revision");
  if ((keys.draftQuoteFingerprints?.apiKey ?? null) !== (revision.draft_quote_api_key_fingerprint ?? null)
    || (keys.draftQuoteFingerprints?.hmac ?? null) !== (revision.draft_quote_hmac_fingerprint ?? null))
    return fail("credentials_unavailable", "Connector draft quote configuration does not match its enrolled revision");
  if (row.source_id !== PRIMARY_ALPHA_SOURCE_ID) {
    // Enrolled primary uses its exact revision, not an obsolete scalar verifier.
    // Secondary must still reject keys currently configured for scalar primary.
    const scalar = await legacyKeys(env);
    if ([keys.current, ...(keys.previous ? [keys.previous] : [])]
      .some(key => scalar.some(old => old.fingerprint === key.fingerprint))) fail("conflict", "A signing key belongs to the primary connection");
  }
  return { revision, ...keys };
}

/** A source hint selects configuration only. Ingress MUST verify its Access
 * subject and payload signature before using this configuration's write proof. */
export async function resolveProjectAlphaConnector(env: ProjectAlphaConnectorEnvironment, requestedSource: string,
  purpose: "snapshot" | "events" | "draft_quote"): Promise<ResolvedProjectAlphaConnector> {
  const id = sourceId(requestedSource), db = database(env), row = await read(db, id);
  if (!row || (id === PRIMARY_ALPHA_SOURCE_ID && row.state === "pending")) {
    if (id !== PRIMARY_ALPHA_SOURCE_ID) return fail("unavailable", "Connector is not registered");
    // Trusted deployment configuration, not caller authentication: retain old
    // key ownership even if it is rotated away before explicit enrollment.
    const legacy = await legacyKeys(env);
    if (legacy.length) {
      try { await db.batch(reservationStatements(db, legacy.map(key => ({ key, owner: PRIMARY_ALPHA_SOURCE_ID })))); }
      catch (error) { writeError(error); }
    }
    const legacyProof: ProjectAlphaConnectorProof = Object.freeze({ mode: "legacy_primary", sourceId: id, revision: 0, version: 0, profile: "primary_legacy" });
    const snapshot = purpose === "snapshot" && env.PROJECT_ALPHA_BASE_URL && env.PROJECT_ALPHA_API_KEY
      ? { baseUrl: env.PROJECT_ALPHA_BASE_URL, apiKey: env.PROJECT_ALPHA_API_KEY, applicationKey: env.APPLICATION_KEY ?? "" } : null;
    // The legacy event receiver intentionally keeps its existing dual verifier:
    // current/previous Ed25519 AND optional HMAC are not a new registry profile.
    await assertProjectAlphaConnectorProof(env, legacyProof);
    return { source: createProjectAlphaSourceContext(id), proof: legacyProof, snapshot, event: null, draftQuote: null };
  }
  const currentProof = proof(row);
  await assertProjectAlphaConnectorProof(env, currentProof);
  const config = await verifiedConfiguration(env, row);
  await assertProjectAlphaConnectorProof(env, currentProof);
  return { source: createProjectAlphaSourceContext(id), proof: currentProof,
    snapshot: { baseUrl: `${row.snapshot_origin}${row.snapshot_base_path === "/" ? "" : row.snapshot_base_path}`,
      apiKey: config.set.snapshotApiKey, applicationKey: row.application_key },
    event: { applicationKey: row.application_key, accessIssuer: config.revision.access_issuer, accessAudience: config.revision.access_audience,
      accessSubject: config.revision.access_subject, current: config.current, previous: config.previous },
    draftQuote: purpose === "draft_quote" && config.set.draftQuote ? {
      baseUrl: row.snapshot_origin, applicationKey: row.application_key,
      apiKey: config.set.draftQuote.apiKey, hmacSecret: config.set.draftQuote.hmacSecret,
    } : null };
}

async function keyReservations(env: ProjectAlphaConnectorEnvironment, id: string, current: ConnectorSigningKey, previous: ConnectorSigningKey | null) {
  const rows = new Map<string, { key: ConnectorSigningKey; owner: string }>();
  for (const key of await legacyKeys(env)) rows.set(key.fingerprint, { key, owner: PRIMARY_ALPHA_SOURCE_ID });
  for (const key of [current, ...(previous ? [previous] : [])]) {
    const prior = rows.get(key.fingerprint);
    if (prior && prior.owner !== id) return fail("conflict", "A signing key belongs to another connection");
    rows.set(key.fingerprint, { key, owner: id });
  }
  return reservationStatements(database(env), [...rows.values()]);
}
function reservationStatements(db: RegistryDatabase, rows: { key: ConnectorSigningKey; owner: string }[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const { key, owner } of new Map(rows.map(row => [row.key.fingerprint, row])).values()) {
    // Exact existing reservations produce no INSERT (outer UPSERT policies can
    // override a trigger's OR IGNORE). A different owner triggers a hard error.
    statements.push(db.prepare(`INSERT INTO pa_connector_signing_keys(fingerprint,source_id,algorithm)
      SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM pa_connector_signing_keys WHERE fingerprint=? AND source_id=? AND algorithm=?)`)
      .bind(key.fingerprint, owner, key.algorithm, key.fingerprint, owner, key.algorithm));
  }
  return statements;
}
function revisionStatement(db: RegistryDatabase, id: string, revision: number, value: ProjectAlphaConnectorRevisionInput,
  current: ConnectorSigningKey, previous: ConnectorSigningKey | null, actorId: string,
  draftQuoteFingerprints: { apiKey: string; hmac: string } | null) {
  // Ordered migration verification exercises the connector registry before
  // migration 0050 adds the optional quote-purpose columns. Omit them only
  // when no quote credential exists; configured credentials still require the
  // complete schema and therefore fail closed if migration 0050 is absent.
  if (!draftQuoteFingerprints) return db.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,
    access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,previous_key_id,previous_key_fingerprint,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, revision, value.credentialRef, value.snapshotBasePath, value.accessIssuer, value.accessAudience,
      value.accessSubject, current.keyId, current.fingerprint, previous?.keyId ?? null, previous?.fingerprint ?? null, actorId);
  return db.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,
    access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,previous_key_id,previous_key_fingerprint,created_by,
    draft_quote_api_key_fingerprint,draft_quote_hmac_fingerprint)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, revision, value.credentialRef, value.snapshotBasePath, value.accessIssuer, value.accessAudience,
      value.accessSubject, current.keyId, current.fingerprint, previous?.keyId ?? null, previous?.fingerprint ?? null, actorId,
      draftQuoteFingerprints.apiKey,draftQuoteFingerprints.hmac);
}
function draftQuoteReservationStatements(db: RegistryDatabase, owner: string,
  rows: DraftQuoteCredentialReservation[]): D1PreparedStatement[] {
  return rows.map(row => db.prepare(`INSERT INTO pa_connector_draft_quote_credentials
      (ownership_fingerprint,purpose_fingerprint,source_id,purpose)
    SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM pa_connector_draft_quote_credentials
      WHERE ownership_fingerprint=? AND purpose_fingerprint=? AND source_id=? AND purpose=?)`)
    .bind(row.ownershipFingerprint,row.purposeFingerprint,owner,row.purpose,
      row.ownershipFingerprint,row.purposeFingerprint,owner,row.purpose));
}
function auditStatement(db: RegistryDatabase, id: string, actorId: string, action: string, version: number, details: object) {
  return db.prepare("INSERT INTO pa_connector_audit(id,source_id,actor_id,action,version,details_json) VALUES(?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), id, actorId, action, version, JSON.stringify(details));
}
function mutationFence(db: RegistryDatabase, id: string, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) fail("invalid", "Connector version is invalid");
  return fence(db, id, "EXISTS(SELECT 1 FROM pa_connectors WHERE source_id=? AND version=?)", [id, expectedVersion]);
}
function writeError(error: unknown): never {
  if (error instanceof ProjectAlphaConnectorError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/(?:UNIQUE|CHECK|FOREIGN KEY) constraint failed|connector (?:registration|ownership|revision|signing|draft quote)|pa_connector_active_revision_guard/i.test(message))
    return fail("conflict", "Connector configuration conflicts with its current ownership or version");
  return fail("unavailable", "Connector configuration could not be saved");
}
/** Internal administration primitives. Callers enforce current integrations.manage
 * and origin/CSRF policy; these functions never infer authority from actor IDs. */
export async function registerProjectAlphaConnector(env: ProjectAlphaConnectorEnvironment, input: RegisterProjectAlphaConnectorInput,
  actorId: string): Promise<ProjectAlphaConnectorSummary> {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) return fail("invalid", "Connector registration is invalid");
  const value = parsed.data, id = sourceId(value.sourceId), author = actor(actorId), revision = parseRevision(value.revision);
  if ((id === PRIMARY_ALPHA_SOURCE_ID) !== (value.profile === "primary_legacy")) fail("invalid", "Connector authority profile is invalid");
  const snapshotOrigin = origin(value.snapshotOrigin), keys = await configuredKeys(env, revision.credentialRef, value.profile), db = database(env);
  if (id === PRIMARY_ALPHA_SOURCE_ID) await pinPrimaryEnrollment(env, { ...value, snapshotOrigin, revision }, keys.current, keys.previous);
  const count = await db.prepare("SELECT count(*) count FROM pa_connectors").first<number>("count");
  if ((count ?? 0) >= MAX_CONNECTORS) fail("capacity", "The connector registry has reached its configured limit");
  try {
    await db.batch([
      ...await keyReservations(env, id, keys.current, keys.previous),
      ...draftQuoteReservationStatements(db,id,keys.draftQuoteReservations),
      db.prepare(`INSERT INTO pa_connectors(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,
        profile,display_name,read_visible,created_by) VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(id, value.producerBindingId, snapshotOrigin, revision.snapshotBasePath, value.applicationKey, value.profile, value.displayName, id === PRIMARY_ALPHA_SOURCE_ID ? 1 : 0, author),
      revisionStatement(db, id, 1, revision, keys.current, keys.previous, author, keys.draftQuoteFingerprints),
      auditStatement(db, id, author, "registered", 1, { state: "pending", profile: value.profile, revision: 1 }),
    ]);
  } catch (error) { writeError(error); }
  const saved = await read(db, id); if (!saved) return fail("unavailable", "Connector registration could not be verified");
  return summary(saved);
}
export async function reviseProjectAlphaConnector(env: ProjectAlphaConnectorEnvironment, requestedSource: string, expectedVersion: number,
  input: ProjectAlphaConnectorRevisionInput, actorId: string, administrationFence?: D1PreparedStatement): Promise<ProjectAlphaConnectorSummary> {
  const id = sourceId(requestedSource), author = actor(actorId), value = parseRevision(input), db = database(env), row = await read(db, id);
  if (!row) return fail("unavailable", "Connector is not registered");
  if (row.state === "retired" || row.snapshot_base_path !== value.snapshotBasePath) return fail("conflict", "Connector destination ownership cannot change");
  const keys = await configuredKeys(env, value.credentialRef, row.profile), revision = row.active_revision + 1;
  try {
    await db.batch([
      ...(administrationFence ? [administrationFence] : []),
      mutationFence(db, id, expectedVersion), ...await keyReservations(env, id, keys.current, keys.previous),
      ...draftQuoteReservationStatements(db,id,keys.draftQuoteReservations),
      revisionStatement(db, id, revision, value, keys.current, keys.previous, author, keys.draftQuoteFingerprints),
      db.prepare("UPDATE pa_connectors SET active_revision=?,version=version+1,updated_at=datetime('now') WHERE source_id=? AND version=?")
        .bind(revision, id, expectedVersion),
      auditStatement(db, id, author, "revised", expectedVersion + 1, { revision }),
    ]);
  } catch (error) { writeError(error); }
  const saved = await read(db, id); if (!saved) return fail("unavailable", "Connector revision could not be verified");
  return summary(saved);
}
export async function setProjectAlphaConnectorState(env: ProjectAlphaConnectorEnvironment, requestedSource: string,
  input: { expectedVersion: number; state: ProjectAlphaConnectorState; readVisible?: boolean; displayName?: string }, actorId: string,
  administrationFence?: D1PreparedStatement): Promise<ProjectAlphaConnectorSummary> {
  const parsed = z.object({ expectedVersion: z.number().int().positive(), state: z.enum(["pending", "active", "suspended", "retired"]),
    readVisible: z.boolean().optional(), displayName: scalar(160).refine(value => value.trim() === value).optional() }).strict().safeParse(input);
  if (!parsed.success) return fail("invalid", "Connector state change is invalid");
  const value = parsed.data, id = sourceId(requestedSource), author = actor(actorId), db = database(env), row = await read(db, id);
  if (!row) return fail("unavailable", "Connector is not registered");
  assertProjectAlphaConnectorStateTransition(row.state, value.state);
  if (id === PRIMARY_ALPHA_SOURCE_ID && value.readVisible === false) return fail("invalid", "Primary business visibility cannot be disabled here");
  if (value.state === "active") await verifiedConfiguration(env, row);
  try {
    await db.batch([
      ...(administrationFence ? [administrationFence] : []),
      mutationFence(db, id, value.expectedVersion),
      db.prepare(`UPDATE pa_connectors SET state=?,read_visible=?,display_name=?,version=version+1,updated_at=datetime('now') WHERE source_id=? AND version=?`)
        .bind(value.state, value.readVisible === undefined ? row.read_visible : Number(value.readVisible), value.displayName ?? row.display_name, id, value.expectedVersion),
      auditStatement(db, id, author, "state_changed", value.expectedVersion + 1,
        { state: value.state, readVisible: value.readVisible ?? row.read_visible === 1, displayName: value.displayName ?? row.display_name }),
    ]);
  } catch (error) { writeError(error); }
  const saved = await read(db, id); if (!saved) return fail("unavailable", "Connector state could not be verified");
  return summary(saved);
}
export async function listProjectAlphaConnectors(env: ProjectAlphaConnectorEnvironment): Promise<ProjectAlphaConnectorSummary[]> {
  const rows = (await database(env).prepare("SELECT * FROM pa_connectors ORDER BY source_id LIMIT ?").bind(MAX_CONNECTORS + 1).all<ConnectorRow>()).results;
  if (rows.length > MAX_CONNECTORS) return fail("capacity", "The connector registry exceeds its supported limit");
  return rows.map(summary);
}
