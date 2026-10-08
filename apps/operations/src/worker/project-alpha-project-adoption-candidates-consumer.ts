import { resolveProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import { readConfiguredProjectAlphaProjectAdoptionCandidates,
  type ProjectAlphaProjectAdoptionCandidate } from "./project-alpha-project-adoption-candidates-api-v2";

export type ProjectAdoptionCandidatesActor = Readonly<{ staffId: string; accessSubject: string }>;
export type ProjectAdoptionCandidatesEnvironment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
export type AuthorizedProjectAdoptionCandidate = ProjectAlphaProjectAdoptionCandidate & Readonly<{
  organizationRecordId: string | null; clientRecordId: string | null;
}>;
export type ProjectAdoptionCandidatesOutcome =
  | Readonly<{ status: "observed"; authorizationGeneration: string;
      projects: readonly AuthorizedProjectAdoptionCandidate[]; nextCursor: string | null }>
  | Readonly<{ status: "rejected"; reason: "invalid_actor" | "invalid_query" }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "remote" }>
  | Readonly<{ status: "uncertain"; reason: "database" | "remote" }>;

type ActorState = Readonly<{ admission: number; profile: number; generation: number; owner: number }>;
type Scope = Readonly<{ scopeKind: "business_area"; businessAreaId: string; divisionId: null }
  | { scopeKind: "division"; businessAreaId: string; divisionId: string }>;
type Grant = Readonly<{ effect: "allow" | "deny"; scope_kind: "global" | "business_area" | "division" | "exact_project";
  business_area_id: string | null; division_id: string | null }>;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;

function validActor(value: unknown): value is ProjectAdoptionCandidatesActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && typeof row.staffId === "string" && row.staffId.length > 0 && row.staffId.length <= 191
    && typeof row.accessSubject === "string" && row.accessSubject.length > 0 && row.accessSubject.length <= 764
    && !/[\u0000-\u001f\u007f]/.test(row.staffId) && !/[\u0000-\u001f\u007f]/.test(row.accessSubject);
}
async function state(db: D1Database, actor: ProjectAdoptionCandidatesActor): Promise<ActorState | null> {
  return db.prepare(`SELECT admission.version admission,profile.version profile,generation.generation,
      EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND role.role_id='role-owner' AND role.scope='global') owner
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?`)
    .bind(actor.staffId, actor.accessSubject).first<ActorState>();
}
async function grants(db: D1Database, staffId: string): Promise<readonly Grant[]> {
  return (await db.prepare(`SELECT effect,scope_kind,business_area_id,division_id FROM native_project_grants
    WHERE staff_id=? AND capability='project.shared.sync' AND active=1
    ORDER BY effect,scope_kind,ifnull(business_area_id,''),ifnull(division_id,'')`).bind(staffId).all<Grant>()).results;
}
function authorized(rows: readonly Grant[], scopes: readonly Scope[]): boolean {
  const targets: readonly (Scope | undefined)[] = scopes.length ? scopes : [undefined];
  const applies = (grant: Grant, scope: Scope | undefined) => grant.scope_kind === "global"
    || !!scope && grant.scope_kind === "business_area" && grant.business_area_id === scope.businessAreaId
    || !!scope && grant.scope_kind === "division" && grant.business_area_id === scope.businessAreaId
      && grant.division_id === scope.divisionId;
  return targets.every(scope => rows.some(row => row.effect === "allow" && applies(row, scope)))
    && !targets.some(scope => rows.some(row => row.effect === "deny" && applies(row, scope)));
}
async function mapping(db: D1Database, ids: Readonly<{ source: string; instance: string; application: string; epoch: string }>,
  kind: "organization" | "client", publicId: string | null): Promise<string | null | undefined> {
  if (publicId === null) return null;
  const rows = (await db.prepare(`SELECT mapping.record_id FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=?
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type=? AND mapping.project_alpha_public_id=? ORDER BY mapping.record_id`)
    .bind(kind, ids.source, ids.instance, ids.application, ids.epoch, kind, publicId).all<{ record_id: string }>()).results;
  return rows.length === 1 ? rows[0]!.record_id : undefined;
}
async function authorizeCandidate(db: D1Database, ids: Readonly<{ source: string; instance: string; application: string; epoch: string }>,
  candidate: ProjectAlphaProjectAdoptionCandidate, liveGrants: readonly Grant[]): Promise<AuthorizedProjectAdoptionCandidate | null> {
  const [organizationRecordId, clientRecordId] = await Promise.all([
    mapping(db, ids, "organization", candidate.organizationPublicId), mapping(db, ids, "client", candidate.clientPublicId),
  ]);
  if (organizationRecordId === undefined || clientRecordId === undefined) return null;
  if (organizationRecordId && clientRecordId && !await db.prepare(`SELECT 1 ok FROM operations_directory_client_organizations
    WHERE organization_record_id=? AND client_record_id=?`).bind(organizationRecordId, clientRecordId).first("ok")) return null;
  const recordIds = [organizationRecordId, clientRecordId].filter((id): id is string => id !== null);
  const scopeRows = recordIds.length ? (await db.prepare(`SELECT scope.scope_kind,scope.business_area_id,scope.division_id,
      area.active area_active,division.active division_active FROM native_directory_resource_scopes scope
    JOIN native_business_areas area ON area.id=scope.business_area_id
    LEFT JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id
    WHERE scope.active=1 AND scope.record_id IN (${recordIds.map(() => "?").join(",")})
    ORDER BY scope.scope_kind,scope.business_area_id,ifnull(scope.division_id,'')`).bind(...recordIds).all<{
      scope_kind: "business_area" | "division"; business_area_id: string; division_id: string | null;
      area_active: number; division_active: number | null;
    }>()).results : [];
  const unique = new Map<string, Scope>();
  for (const row of scopeRows) {
    if (row.area_active !== 1 || row.scope_kind === "division" && (row.division_id === null || row.division_active !== 1)) return null;
    const scope: Scope = row.scope_kind === "business_area"
      ? { scopeKind: "business_area", businessAreaId: row.business_area_id, divisionId: null }
      : { scopeKind: "division", businessAreaId: row.business_area_id, divisionId: row.division_id! };
    unique.set(`${scope.scopeKind}\0${scope.businessAreaId}\0${scope.divisionId ?? ""}`, scope);
  }
  if (!authorized(liveGrants, [...unique.values()])) return null;
  return { ...candidate, organizationRecordId, clientRecordId };
}

export async function listAuthorizedProjectAlphaProjectAdoptionCandidates(env: ProjectAdoptionCandidatesEnvironment,
  actorValue: unknown, query: Readonly<{ sourceId: string; cursor?: string | null; limit?: number }>,
  send: typeof fetch = fetch): Promise<ProjectAdoptionCandidatesOutcome> {
  if (!validActor(actorValue)) return { status: "rejected", reason: "invalid_actor" };
  if (!query || typeof query !== "object" || Array.isArray(query)
    || Object.keys(query).some(key => key !== "sourceId" && key !== "cursor" && key !== "limit")
    || !SOURCE.test(query.sourceId)
    || query.cursor !== undefined && query.cursor !== null && !PUBLIC_ID.test(query.cursor)
    || query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200))
    return { status: "rejected", reason: "invalid_query" };
  let connection;
  try { connection = resolveProjectAlphaApiV2Connection(env, query.sourceId); }
  catch { return { status: "blocked", reason: "configuration" }; }
  if (!connection.enabled) return { status: "blocked", reason: "configuration" };
  let initial: ActorState | null, liveGrants: readonly Grant[];
  try { [initial, liveGrants] = await Promise.all([state(env.OPS_DB, actorValue), grants(env.OPS_DB, actorValue.staffId)]); }
  catch { return { status: "uncertain", reason: "database" }; }
  if (!initial || initial.owner !== 1) return { status: "blocked", reason: "authority" };
  const remote = await readConfiguredProjectAlphaProjectAdoptionCandidates(env, query.sourceId,
    { cursor: query.cursor, limit: query.limit }, send).catch(() => null);
  if (!remote || remote.status !== "observed") return remote?.status === "uncertain"
    ? { status: "uncertain", reason: "remote" } : { status: "blocked", reason: "remote" };
  const ids = { source: query.sourceId, instance: connection.connection.expectedSourceInstanceId,
    application: connection.connection.expectedApplicationId, epoch: connection.connection.expectedHistoryEpoch! };
  try {
    const projects = (await Promise.all(remote.response.projects.map(item => authorizeCandidate(env.OPS_DB, ids, item, liveGrants))))
      .filter((item): item is AuthorizedProjectAdoptionCandidate => item !== null);
    const [final, finalGrants] = await Promise.all([state(env.OPS_DB, actorValue), grants(env.OPS_DB, actorValue.staffId)]);
    if (!final || final.owner !== 1 || JSON.stringify(final) !== JSON.stringify(initial))
      return { status: "blocked", reason: "authority" };
    const finalProjects = (await Promise.all(remote.response.projects.map(item =>
      authorizeCandidate(env.OPS_DB, ids, item, finalGrants))))
      .filter((item): item is AuthorizedProjectAdoptionCandidate => item !== null);
    if (JSON.stringify(finalProjects) !== JSON.stringify(projects)) return { status: "blocked", reason: "authority" };
    return { status: "observed", authorizationGeneration: remote.response.authorizationGeneration,
      projects: finalProjects, nextCursor: remote.response.nextCursor };
  } catch { return { status: "uncertain", reason: "database" }; }
}
