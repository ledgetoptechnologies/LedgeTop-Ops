import type { JWTVerifyGetKey } from 'jose';
import { AGENT_READ_PREFIX, AGENT_STAGING_HOST, verifyAgentService } from './agent-service-auth';
import { resolveProjectAlphaApiV2Connection, probeConfiguredProjectAlphaApiV2Connection } from './project-alpha-api-v2-connections';
import type { Env } from './types';

type AgentEnvironment = Pick<Env, 'OPS_DB' | 'ENVIRONMENT' | 'TEAM_DOMAIN' | 'OPERATIONS_AUD' | 'PROJECT_ALPHA_API_V2_CONNECTIONS'
  | 'PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS'> & { OPS_AGENT_READ_ENABLED?: string; OPS_AGENT_READ_AUD?: string };
type Principal = { id: string; owner_staff_id: string; version: number };
type SourceGrant = { projection_source_id: string; origin: string; source_instance_id: string; application_id: string; history_epoch_id: string };
type Action = 'connection' | 'clients.lookup' | 'clients.detail';
type Probe = typeof probeConfiguredProjectAlphaApiV2Connection;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
const principalWhere = `p.status='active' AND p.expires_at>unixepoch()
  AND EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles f ON f.staff_id=a.staff_id
    JOIN staff_users u ON u.id=f.staff_id WHERE a.staff_id=p.owner_staff_id AND a.active=1 AND u.status='active'
      AND a.version=p.owner_admission_version AND a.bound_access_subject=p.owner_access_subject)`;

async function principal(db: D1Database, client: string, version?: number): Promise<Principal | null> {
  return db.withSession('first-primary').prepare(`SELECT p.id,p.owner_staff_id,p.version FROM ops_agent_principals p
    WHERE p.access_client_id=? AND ${principalWhere} ${version === undefined ? '' : 'AND p.version=?'}`)
    .bind(...(version === undefined ? [client] : [client, version])).first<Principal>();
}

/** Fixed native directory read policy, with no administrator/role bypass. */
function ownerGrantApplies(alias: string): string {
  return `(${alias}.scope_kind='global' OR (${alias}.scope_kind='resource' AND ${alias}.resource_id=r.record_id)
    OR (${alias}.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
      WHERE assignment.staff_id=p.owner_staff_id AND assignment.record_id=r.record_id AND assignment.active=1))
    OR (${alias}.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
      JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
      WHERE scope.record_id=r.record_id AND scope.active=1 AND scope.business_area_id=${alias}.business_area_id))
    OR (${alias}.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
      JOIN native_business_divisions division ON division.id=scope.division_id AND division.active=1
      JOIN native_business_areas area ON area.id=division.business_area_id AND area.active=1
      WHERE scope.record_id=r.record_id AND scope.active=1 AND scope.division_id=${alias}.division_id)))`;
}
const ownerPolicy = `EXISTS(SELECT 1 FROM native_directory_grants own WHERE own.staff_id=p.owner_staff_id
  AND own.permission='directory.profile.view' AND own.effect='allow' AND own.active=1 AND ${ownerGrantApplies('own')})
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=p.owner_staff_id
    AND deny.permission='directory.profile.view' AND deny.effect='deny' AND deny.active=1
    AND (${ownerGrantApplies('deny')} OR (deny.scope_kind IN ('division','business_area') AND NOT EXISTS(
      SELECT 1 FROM native_directory_resource_scopes classified
      JOIN native_business_areas area ON area.id=classified.business_area_id AND area.active=1
      LEFT JOIN native_business_divisions division ON division.id=classified.division_id AND division.active=1
      WHERE classified.record_id=r.record_id AND classified.active=1
        AND (deny.scope_kind='business_area' OR (classified.scope_kind='division' AND division.id IS NOT NULL))))))`;

async function readRows(env: AgentEnvironment, actor: Principal, client: string, sourceId: string,
  source: SourceGrant, identity: string, recordId: string | null, q: string, cursor: string, limit: number) {
  const db = env.OPS_DB.withSession('first-primary');
  return (await db.prepare(`SELECT DISTINCT r.record_id,r.record_kind,r.current_version,revision.profile_json
    FROM operations_directory_records r JOIN operations_directory_revisions revision
      ON revision.record_id=r.record_id AND revision.version=r.current_version
    JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=r.record_id AND mapping.resource_type=r.record_kind
    JOIN ops_agent_principals p ON p.id=? AND p.version=? AND p.access_client_id=? AND ${principalWhere}
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND (SELECT count(*) FROM project_alpha_active_directory_mappings exact WHERE exact.source_id=mapping.source_id
        AND exact.record_id=r.record_id AND exact.resource_type=r.record_kind AND exact.source_instance_id=mapping.source_instance_id
        AND exact.application_id=mapping.application_id AND exact.history_epoch_id=mapping.history_epoch_id)=1
      AND EXISTS(SELECT 1 FROM pa_connectors connector WHERE connector.source_id=? AND connector.read_visible=1 AND connector.snapshot_origin=?)
      AND EXISTS(SELECT 1 FROM pa_local_division_source_heads head WHERE head.projection_source_id=? AND head.identity_key=?)
      AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state WHERE state.record_id=r.record_id AND state.status<>'active')
      AND ${ownerPolicy}
      AND EXISTS(SELECT 1 FROM ops_agent_read_grants g WHERE g.agent_id=p.id AND g.source_id=mapping.source_id AND g.active=1
        AND g.effect='allow' AND g.projection_source_id=? AND g.origin=? AND g.source_instance_id=mapping.source_instance_id
        AND g.application_id=mapping.application_id AND g.history_epoch_id=mapping.history_epoch_id
        AND (g.scope_kind='source' OR g.record_id=r.record_id))
      AND NOT EXISTS(SELECT 1 FROM ops_agent_read_grants denied WHERE denied.agent_id=p.id AND denied.source_id=mapping.source_id
        AND denied.active=1 AND denied.effect='deny' AND (denied.scope_kind='source' OR denied.record_id=r.record_id))
      AND (? IS NULL OR r.record_id=?) AND r.record_id>? AND instr(lower(json_extract(revision.profile_json,'$.name')),lower(?))>0
    ORDER BY r.record_id LIMIT ?`).bind(actor.id, actor.version, client, sourceId, source.source_instance_id, source.application_id,
    source.history_epoch_id, source.projection_source_id, source.origin, source.projection_source_id, identity, source.projection_source_id, source.origin,
    recordId, recordId, cursor, q, limit).all<{ record_id: string; record_kind: string; current_version: number; profile_json: string }>()).results;
}

async function audit(db: D1Database, actor: Principal, requestId: string, action: Action, outcome: 'allowed' | 'denied' | 'rate_limited') {
  // Intentionally excludes queries, profile contents, URLs, source credentials and raw assertions.
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO ops_agent_read_audit(event_id,request_id,agent_id,owner_staff_id,action,outcome) VALUES(?,?,?,?,?,?)`)
    .bind(id, requestId, actor.id, actor.owner_staff_id, action, outcome).run();
  if (!await db.withSession('first-primary').prepare('SELECT event_id FROM ops_agent_read_audit WHERE event_id=?').bind(id).first()) throw Error('audit_unavailable');
}

/** Third argument is a trusted test seam only; HTTP/configuration cannot supply functions. */
export async function handleAgentRead(request: Request, env: AgentEnvironment,
  dependencies: { keyResolver?: JWTVerifyGetKey; probe?: Probe } = {}): Promise<Response> {
  const url = new URL(request.url);
  if (env.ENVIRONMENT !== 'staging' || env.OPS_AGENT_READ_ENABLED !== 'true' || !env.OPS_AGENT_READ_AUD
    || env.OPS_AGENT_READ_AUD === env.OPERATIONS_AUD || url.protocol !== 'https:' || url.host !== AGENT_STAGING_HOST)
    return response({ error: 'Not found' }, 404);
  if (request.method !== 'GET') return response({ error: 'Method not allowed' }, 405);
  const connection = url.pathname === `${AGENT_READ_PREFIX}/connection`;
  const lookup = url.pathname === `${AGENT_READ_PREFIX}/clients`;
  const detail = /^\/api\/agent\/v1\/clients\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!connection && !lookup && !detail) return response({ error: 'Not found' }, 404);
  const action: Action = connection ? 'connection' : lookup ? 'clients.lookup' : 'clients.detail';
  let actor: Principal | null = null;
  const requestId = crypto.randomUUID();
  try {
    const service = await verifyAgentService(request, { environment: env.ENVIRONMENT, enabled: env.OPS_AGENT_READ_ENABLED,
      issuer: env.TEAM_DOMAIN, audience: env.OPS_AGENT_READ_AUD }, dependencies.keyResolver);
    actor = await principal(env.OPS_DB, service.accessClientId);
    if (!actor) return response({ error: 'Agent access denied' }, 403);
    const reservation = await env.OPS_DB.withSession('first-primary').prepare(`INSERT INTO ops_agent_read_rate_windows(agent_id,minute,requests)
      VALUES(?,unixepoch()/60,1) ON CONFLICT(agent_id,minute) DO UPDATE SET requests=requests+1 WHERE requests<60 RETURNING requests`)
      .bind(actor.id).first<number>('requests');
    if (reservation === null) { await audit(env.OPS_DB, actor, requestId, action, 'rate_limited'); return response({ error: 'Agent rate limited' }, 429); }
    if (connection) {
      if (url.search) throw Error();
      await audit(env.OPS_DB, actor, requestId, action, 'allowed');
      if (!await principal(env.OPS_DB, service.accessClientId, actor.version) || Date.now() / 1000 >= service.expiresAt) throw Error();
      return response({ principal: { kind: 'agent', id: actor.id }, readOnly: true, tools: ['get_connection', 'find_clients', 'get_client'] });
    }
    if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw Error();
    const allowed = lookup ? ['sourceId', 'q', 'cursor', 'limit'] : [];
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key))) throw Error();
    const sourceId = detail ? decodeURIComponent(detail[1]!) : url.searchParams.get('sourceId') ?? '';
    const recordId = detail ? decodeURIComponent(detail[2]!) : null;
    const q = url.searchParams.get('q') ?? '', cursor = url.searchParams.get('cursor') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? '20');
    if (!SOURCE.test(sourceId) || (recordId !== null && !ID.test(recordId)) || q.length > 100 || /\p{C}/u.test(q)
      || (cursor !== '' && !ID.test(cursor)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw Error();
    const grants = (await env.OPS_DB.withSession('first-primary').prepare(`SELECT projection_source_id,origin,source_instance_id,application_id,history_epoch_id
      FROM ops_agent_read_grants WHERE agent_id=? AND source_id=? AND active=1 AND effect='allow' LIMIT 65`)
      .bind(actor.id, sourceId).all<SourceGrant>()).results;
    if (!grants.length || grants.length > 64 || !env.PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS) throw Error();
    const source = grants[0]!, identity = JSON.stringify([source.origin, source.source_instance_id, source.application_id, source.history_epoch_id]);
    if (grants.some(g => JSON.stringify(g) !== JSON.stringify(source)) || !SOURCE.test(source.projection_source_id)) throw Error();
    const directory = resolveProjectAlphaApiV2Connection(env, sourceId);
    const observerEnv = { PROJECT_ALPHA_API_V2_CONNECTIONS: env.PROJECT_ALPHA_LOCAL_DIVISION_IDENTITY_CONNECTIONS };
    const observer = resolveProjectAlphaApiV2Connection(observerEnv, source.projection_source_id);
    const key = (c: typeof directory.connection) => JSON.stringify([c.baseUrl, c.expectedSourceInstanceId, c.expectedApplicationId, c.expectedHistoryEpoch]);
    if (!directory.enabled || !observer.enabled || directory.sourceId !== sourceId || key(directory.connection) !== identity || key(observer.connection) !== identity) throw Error();
    // Always use the dedicated capability-only observer. Never directory/finance credentials.
    const probe = await (dependencies.probe ?? probeConfiguredProjectAlphaApiV2Connection)(observerEnv, source.projection_source_id);
    if (probe.status !== 'verified' || probe.grantedCapabilities.length !== 1 || probe.grantedCapabilities[0] !== 'api.capabilities.read'
      || JSON.stringify([source.origin, probe.sourceInstanceId, probe.applicationId, probe.historyEpoch]) !== identity) throw Error();
    if (!await principal(env.OPS_DB, service.accessClientId, actor.version)) throw Error();
    const rows = await readRows(env, actor, service.accessClientId, sourceId, source, identity, recordId, q, cursor, recordId ? 1 : limit + 1);
    const output = rows.slice(0, limit).map(row => {
      if (row.profile_json.length > 65536) throw Error();
      const profile = JSON.parse(row.profile_json) as Record<string, unknown>;
      const base = { sourceId, recordId: row.record_id, kind: row.record_kind, version: row.current_version, name: profile.name };
      if (typeof base.name !== 'string' || base.name.length > 512) throw Error();
      if (!recordId) return base;
      const fields = ['email', 'phone', 'generalEmail', 'generalPhone', 'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country'];
      return { ...base, profile: Object.fromEntries(fields.filter(k => typeof profile[k] === 'string' && (profile[k] as string).length <= 512).map(k => [k, profile[k]])) };
    });
    await audit(env.OPS_DB, actor, requestId, action, 'allowed');
    // Re-run the SAME policy/data selection after the audit await; ACL, identity
    // head, record versions and principal/grant revocations cannot be cached.
    if (!await principal(env.OPS_DB, service.accessClientId, actor.version)) throw Error();
    const current = await readRows(env, actor, service.accessClientId, sourceId, source, identity, recordId, q, cursor, recordId ? 1 : limit + 1);
    if (JSON.stringify(rows) !== JSON.stringify(current) || Date.now() / 1000 >= service.expiresAt) throw Error();
    if (recordId) return output.length ? response(output[0]) : response({ error: 'Not found' }, 404);
    return response({ clients: output, nextCursor: rows.length > limit ? output.at(-1)?.recordId ?? null : null });
  } catch {
    if (actor) {
      try { await audit(env.OPS_DB, actor, requestId, action, 'denied'); } catch { return response({ error: 'Agent read unavailable' }, 503); }
    }
    return response({ error: 'Agent access denied' }, 403);
  }
}
