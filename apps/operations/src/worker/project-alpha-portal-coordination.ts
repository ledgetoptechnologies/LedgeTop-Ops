import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import {
  getPortalSourceAuthority, portalSourceAuthoritiesReady, PortalSourceAuthorityError,
  provisionPortalSourceAuthority, setPortalSourceAuthorityState,
  type PortalAuthorityConnectorIdentity, type PortalSourceAuthoritySummary, type PortalSourceAuthorityEnvironment,
} from "../../../client/src/worker/project-alpha-portal-authority";
import {
  listProjectAlphaConnectors, ProjectAlphaConnectorError, reviseProjectAlphaConnector,
  setProjectAlphaConnectorState, type ProjectAlphaConnectorRevisionInput,
  type ProjectAlphaConnectorState, type ProjectAlphaConnectorSummary, type ProjectAlphaConnectorEnvironment,
} from "./project-alpha-connectors";
export type ConnectorPortalEnvironment = ProjectAlphaConnectorEnvironment & PortalSourceAuthorityEnvironment;
type Env = ConnectorPortalEnvironment;

type Action = "prepare" | "activate" | "suspend" | "state" | "revision" | "recover";
interface CoordinationRow {
  version: number; token: string | null; source_id: string | null;
  action: Action | null; actor_id: string | null; started_at: string | null;
}
interface Coordination { token: string; version: number; sourceId: string; action: Action; actorId: string }
export interface ConnectorPortalStatus {
  available: boolean;
  authorities: PortalSourceAuthoritySummary[];
  recovery: { version: number; sourceId: string; action: Action; startedAt: string } | null;
}
const unavailable = (message: string): never => { throw new ProjectAlphaConnectorError("unavailable", message); };
const conflict = (message: string): never => { throw new ProjectAlphaConnectorError("changed", message); };
const ops = (env: Env) => env.OPS_DB.withSession("first-primary");

async function ready(env: Env): Promise<boolean> {
  const count = await ops(env).prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN
    ('pa_connector_portal_coordination','pa_connector_portal_coordination_audit','pa_connector_portal_coordination_fences',
      'pa_connector_portal_sources','pa_connector_portal_write_permits')`)
    .first<number>("n");
  return count === 5 && Boolean(env.DELIVERY_DB) && await portalSourceAuthoritiesReady(env.DELIVERY_DB);
}
async function requireReady(env: Env): Promise<void> {
  if (!await ready(env)) unavailable("Client portal connection support requires the coordinated database upgrade");
}
/** An older business-only installation may still administer connections. Once
 * either database records portal enrollment, a missing/partial paired upgrade
 * must never downgrade a source mutation to the uncoordinated path. */
async function requireUnusedPortalSchema(env: Env): Promise<void> {
  const opsTables = await ops(env).prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN
    ('pa_connector_portal_coordination','pa_connector_portal_coordination_audit','pa_connector_portal_coordination_fences',
      'pa_connector_portal_sources','pa_connector_portal_write_permits')`).first<number>("n");
  if (opsTables !== 0 && opsTables !== 5) return unavailable("Portal coordination schema is incomplete; finish the coordinated upgrade before changing connections");
  if (opsTables === 5 && await ops(env).prepare("SELECT 1 enrolled FROM pa_connector_portal_sources LIMIT 1").first())
    return unavailable("Portal connections are enrolled; restore the paired database support before changing connections");
  if (!env.DELIVERY_DB) return;
  const delivery = env.DELIVERY_DB.withSession("first-primary");
  const deliveryTables = await delivery.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN
    ('pa_portal_source_authorities','pa_portal_source_authority_revisions','pa_portal_source_signing_keys',
      'pa_portal_source_authority_audit','pa_portal_source_write_fences')`).first<number>("n");
  if (deliveryTables !== 0 && deliveryTables !== 5) return unavailable("Portal authority schema is incomplete; finish the coordinated upgrade before changing connections");
  if (deliveryTables === 5 && await delivery.prepare("SELECT 1 enrolled FROM pa_portal_source_authorities LIMIT 1").first())
    return unavailable("Portal connections are enrolled; restore the paired database support before changing connections");
}
async function source(env: Env, sourceId: string): Promise<ProjectAlphaConnectorSummary> {
  const connector = (await listProjectAlphaConnectors(env)).find(row => row.sourceId === sourceId);
  if (!connector) return unavailable("Connection is not registered");
  return connector;
}
function identity(connector: ProjectAlphaConnectorSummary): PortalAuthorityConnectorIdentity {
  if (connector.profile !== "business_data" || connector.sourceId === PRIMARY_ALPHA_SOURCE_ID)
    throw new ProjectAlphaConnectorError("invalid", "The existing primary portal configuration is unchanged");
  return { sourceId: connector.sourceId, producerBindingId: connector.producerBindingId,
    snapshotOrigin: connector.snapshotOrigin, snapshotBasePath: connector.snapshotBasePath,
    applicationKey: connector.applicationKey, profile: connector.profile,
    revision: connector.activeRevision, version: connector.version, state: connector.state };
}
async function row(env: Env): Promise<CoordinationRow> {
  const value = await ops(env).prepare("SELECT version,token,source_id,action,actor_id,started_at FROM pa_connector_portal_coordination WHERE id='portal'")
    .first<CoordinationRow>();
  return value ?? unavailable("Portal connection coordination is unavailable");
}
function guard(env: Env, condition: string, values: (string | number)[]): D1PreparedStatement {
  return ops(env).prepare(`INSERT INTO pa_connector_portal_coordination_fences(id,write_guard)
    VALUES('portal',CASE WHEN ${condition} THEN 1 ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET write_guard=excluded.write_guard`).bind(...values);
}
function coordinationFence(env: Env, operation: Coordination): D1PreparedStatement {
  return guard(env, "EXISTS(SELECT 1 FROM pa_connector_portal_coordination WHERE id='portal' AND token=? AND version=?)",
    [operation.token, operation.version]);
}
function sourceMutationPermit(env: Env, operation: Coordination, expectedVersion: number): D1PreparedStatement {
  return ops(env).prepare(`INSERT INTO pa_connector_portal_write_permits(source_id,expected_version,token,write_guard)
    VALUES(?,?,?,CASE WHEN EXISTS(SELECT 1 FROM pa_connector_portal_coordination WHERE id='portal' AND token=? AND version=?) THEN 1 ELSE 0 END)
    ON CONFLICT(source_id) DO UPDATE SET expected_version=excluded.expected_version,token=excluded.token,write_guard=excluded.write_guard`)
    .bind(operation.sourceId, expectedVersion, operation.token, operation.token, operation.version);
}
async function assertCurrent(env: Env, operation: Coordination): Promise<void> {
  const current = await row(env);
  if (current.token !== operation.token || current.version !== operation.version)
    conflict("The connection update changed. Refresh its status before continuing");
}
function audit(env: Env, operation: Coordination, phase: "started" | "completed", version: number) {
  return ops(env).prepare(`INSERT INTO pa_connector_portal_coordination_audit
    (id,source_id,action,phase,actor_id,coordination_version) VALUES(?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), operation.sourceId, operation.action, phase, operation.actorId, version);
}
function writeFailure(error: unknown): never {
  if (error instanceof ProjectAlphaConnectorError || error instanceof PortalSourceAuthorityError) throw error;
  if (error instanceof Error && /pa_connector_portal_coordination_guard|portal coordination version conflicts/.test(error.message))
    return conflict("Another connection update changed this operation. Refresh connection status");
  return unavailable("The connection update could not be confirmed. Refresh status and recover the unfinished update if shown");
}
async function begin(env: Env, connector: ProjectAlphaConnectorSummary, expectedVersion: number,
  action: Action, actorId: string): Promise<Coordination> {
  await requireReady(env);
  if (connector.version !== expectedVersion) return conflict("Connection changed. Refresh before retrying");
  const current = await row(env);
  if (current.token !== null) return conflict("A connection update is unfinished. Recover it before making another change");
  const operation = { token: crypto.randomUUID(), version: current.version + 1, sourceId: connector.sourceId, action, actorId };
  try {
    await ops(env).batch([
      guard(env, `EXISTS(SELECT 1 FROM pa_connector_portal_coordination WHERE id='portal' AND token IS NULL AND version=?)
        AND EXISTS(SELECT 1 FROM pa_connectors WHERE source_id=? AND version=?)`, [current.version, connector.sourceId, expectedVersion]),
      ops(env).prepare(`UPDATE pa_connector_portal_coordination SET version=version+1,token=?,source_id=?,action=?,actor_id=?,started_at=datetime('now') WHERE id='portal'`)
        .bind(operation.token, connector.sourceId, action, actorId),
      audit(env, operation, "started", operation.version),
    ]);
  } catch (error) { writeFailure(error); }
  return operation;
}
async function finish(env: Env, operation: Coordination): Promise<void> {
  try {
    await ops(env).batch([
      coordinationFence(env, operation),
      ops(env).prepare(`UPDATE pa_connector_portal_coordination SET version=version+1,token=NULL,source_id=NULL,action=NULL,actor_id=NULL,started_at=NULL WHERE id='portal'`),
      audit(env, operation, "completed", operation.version + 1),
    ]);
  } catch (error) { writeFailure(error); }
}
async function authorities(env: Env): Promise<PortalSourceAuthoritySummary[]> {
  const ids = (await env.DELIVERY_DB.withSession("first-primary").prepare(
    "SELECT source_id FROM pa_portal_source_authorities ORDER BY source_id LIMIT 33",
  ).all<{ source_id: string }>()).results;
  if (ids.length > 32) return unavailable("Portal connection registry exceeds its supported limit");
  const result: PortalSourceAuthoritySummary[] = [];
  for (const id of ids) {
    const authority = await getPortalSourceAuthority(env.DELIVERY_DB, id.source_id);
    if (authority) result.push(authority);
  }
  return result;
}
export async function getConnectorPortalStatus(env: Env): Promise<ConnectorPortalStatus> {
  if (!await ready(env)) return { available: false, authorities: [], recovery: null };
  const current = await row(env);
  return { available: true, authorities: await authorities(env), recovery: current.token === null ? null : {
    version: current.version, sourceId: current.source_id!, action: current.action!, startedAt: current.started_at!,
  } };
}

/** A newer recovery token prevents old OPS writes. Delivery CAS versions stop
 * delayed old activations after recovery has disabled a purpose. Always bump a
 * non-retired authority's version, even if it is already suspended/pending. */
async function disable(env: Env, sourceId: string, operation: Coordination): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await assertCurrent(env, operation);
    const current = await getPortalSourceAuthority(env.DELIVERY_DB, sourceId);
    if (!current || current.state === "retired") return;
    const connector = identity(await source(env, sourceId));
    try {
      await setPortalSourceAuthorityState(env, connector, current.version, "suspended", operation.actorId);
      await assertCurrent(env, operation);
      return;
    } catch (error) {
      if (!(error instanceof PortalSourceAuthorityError) || !["changed", "conflict"].includes(error.code)) throw error;
    }
  }
  conflict("Portal access changed while pausing it. Recover the unfinished connection update");
}
async function disableAffected(env: Env, sourceId: string, operation: Coordination): Promise<void> {
  if (sourceId !== PRIMARY_ALPHA_SOURCE_ID) return disable(env, sourceId, operation);
  for (const authority of await authorities(env)) await disable(env, authority.sourceId, operation);
}

/** Route callers retain administrator + deny-aware integrations.manage + CSRF.
 * No credentials or source identity are accepted from the portal-purpose body.
 * Configuration reuses the current revision of the SAME existing connection. */
export async function configureConnectorPortal(env: Env, sourceId: string, expectedVersion: number,
  expectedPortalVersion: number | null, actorId: string): Promise<PortalSourceAuthoritySummary> {
  const connector = await source(env, sourceId), trusted = identity(connector);
  await requireReady(env);
  const previous = await getPortalSourceAuthority(env.DELIVERY_DB, sourceId);
  if ((previous?.version ?? null) !== expectedPortalVersion || connector.state === "retired" || previous?.state === "retired")
    throw new PortalSourceAuthorityError("conflict");
  const operation = await begin(env, connector, expectedVersion, "prepare", actorId);
  await ops(env).batch([
    coordinationFence(env, operation),
    ops(env).prepare("INSERT OR IGNORE INTO pa_connector_portal_sources(source_id,created_by) VALUES(?,?)").bind(sourceId, actorId),
  ]);
  const revision = await ops(env).prepare(`SELECT credential_ref credentialRef,access_issuer accessIssuer,
    access_audience accessAudience,access_subject accessSubject FROM pa_connector_revisions WHERE source_id=? AND revision=?`)
    .bind(sourceId, connector.activeRevision).first<{ credentialRef: string; accessIssuer: string; accessAudience: string; accessSubject: string }>();
  if (!revision) return unavailable("The current connection authentication revision is unavailable");
  await assertCurrent(env, operation);
  const result = await provisionPortalSourceAuthority(env, trusted, revision, expectedPortalVersion, actorId);
  await finish(env, operation);
  return result;
}
export async function changeConnectorPortal(env: Env, sourceId: string, expectedVersion: number,
  expectedPortalVersion: number, state: "active" | "suspended", actorId: string): Promise<PortalSourceAuthoritySummary> {
  const connector = await source(env, sourceId), trusted = identity(connector);
  await requireReady(env);
  const previous = await getPortalSourceAuthority(env.DELIVERY_DB, sourceId);
  if (!previous || previous.version !== expectedPortalVersion || previous.state === "retired")
    throw new PortalSourceAuthorityError("conflict");
  if (state === "active") {
    const primary = await source(env, PRIMARY_ALPHA_SOURCE_ID);
    if (connector.state !== "active" || primary.state !== "active")
      return conflict("Activate the primary and this connection before enabling its client portal");
    if (previous.connectorRevision !== connector.activeRevision) throw new PortalSourceAuthorityError("conflict");
  }
  // Obvious stale/invalid requests above perform no write and need no recovery.
  // A later race still fails the Delivery CAS and retains the durable barrier.
  const operation = await begin(env, connector, expectedVersion, state === "active" ? "activate" : "suspend", actorId);
  await assertCurrent(env, operation);
  const result = await setPortalSourceAuthorityState(env, trusted, expectedPortalVersion, state, actorId);
  await finish(env, operation);
  return result;
}

export async function setCoordinatedProjectAlphaConnectorState(env: Env, sourceId: string,
  input: { expectedVersion: number; state: ProjectAlphaConnectorState; readVisible?: boolean; displayName?: string }, actorId: string) {
  // Before the paired upgrade no secondary portal authority can be provisioned
  // by these routes. Preserve the existing business-only administration API.
  if (!await ready(env)) {
    await requireUnusedPortalSchema(env);
    return setProjectAlphaConnectorState(env, sourceId, input, actorId);
  }
  const connector = await source(env, sourceId);
  const operation = await begin(env, connector, input.expectedVersion, "state", actorId);
  if (input.state !== connector.state && input.state !== "active") await disableAffected(env, sourceId, operation);
  // Label/visibility changes do not revoke client access. Resuming business sync
  // deliberately does not reactivate a portal purpose that was paused earlier.
  const result = await setProjectAlphaConnectorState(env, sourceId, input, actorId, sourceMutationPermit(env, operation, input.expectedVersion));
  await finish(env, operation);
  return result;
}
export async function reviseCoordinatedProjectAlphaConnector(env: Env, sourceId: string, expectedVersion: number,
  input: ProjectAlphaConnectorRevisionInput, actorId: string) {
  if (!await ready(env)) {
    await requireUnusedPortalSchema(env);
    return reviseProjectAlphaConnector(env, sourceId, expectedVersion, input, actorId);
  }
  const connector = await source(env, sourceId);
  const operation = await begin(env, connector, expectedVersion, "revision", actorId);
  await disableAffected(env, sourceId, operation);
  const result = await reviseProjectAlphaConnector(env, sourceId, expectedVersion, input, actorId, sourceMutationPermit(env, operation, expectedVersion));
  await finish(env, operation);
  return result;
}

/** Recovery cancels an uncertain administration attempt, never retries an
 * activation on behalf of an old request. All registered secondary purposes
 * are left paused; primary scalar portal configuration is not modified. */
export async function recoverConnectorPortalCoordination(env: Env, expectedVersion: number, actorId: string): Promise<void> {
  await requireReady(env);
  const current = await row(env);
  if (!current.token || current.version !== expectedVersion || !current.source_id)
    return conflict("The unfinished connection update changed. Refresh before recovery");
  const operation: Coordination = { token: crypto.randomUUID(), version: current.version + 1,
    sourceId: current.source_id, action: "recover", actorId };
  try {
    await ops(env).batch([
      guard(env, "EXISTS(SELECT 1 FROM pa_connector_portal_coordination WHERE id='portal' AND token=? AND version=?)", [current.token, expectedVersion]),
      ops(env).prepare("UPDATE pa_connector_portal_coordination SET version=version+1,token=?,action='recover',actor_id=?,started_at=datetime('now') WHERE id='portal'")
        .bind(operation.token, actorId),
      audit(env, operation, "started", operation.version),
    ]);
  } catch (error) { writeFailure(error); }
  for (const authority of await authorities(env)) await disable(env, authority.sourceId, operation);
  await finish(env, operation);
}
