import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalStaffReadiness, nativeStaffReadinessEnvironment, NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const LIMIT = 20_001;
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');

/** Exact current Operations staff-authority surfaces. These projections contain
 * staff/authorization metadata only; no client records or credential values. */
export const ORDINARY_FRONTEND_AUTHORITY_TABLES = Object.freeze({
  staff_users: ['id','email','display_name','access_subject','status'],
  staff_role_assignments: ['id','staff_id','role_id','scope','division_id','scope_key','created_by','created_at'],
  local_staff_role_assignments: ['id','staff_id','role_id','scope','division_id','created_by','created_at'],
  staff_permission_overrides: ['id','staff_id','permission_key','effect','scope','division_id','scope_key','created_by','created_at'],
  staff_divisions: ['staff_id','division_id','is_primary','created_at'],
  roles: ['id','name','description','immutable','created_at','updated_at'],
  permissions: ['key','description'],
  role_permissions: ['role_id','permission_key'],
  divisions: ['id','name','code','active','created_at','updated_at'],
  native_staff_admissions: ['staff_id','bound_access_subject','active','admitted_by','version','created_at','updated_at'],
  native_staff_profiles: ['staff_id','login_email','display_name','version','created_at','updated_at'],
  native_staff_admin_delegations: ['id','actor_staff_id','action','effect','scope_kind','business_area_id','division_id',
    'target_staff_id','active','version','granted_by','created_at','updated_at'],
  native_staff_management_delegations: ['id','actor_staff_id','contract_version','authority_domain','capability','effect',
    'scope_kind','business_area_id','division_id','target_staff_id','active','version','granted_by','created_at','updated_at'],
  native_staff_access_reconciliation: ['singleton','enabled','generation','applied_generation','lease_id','lease_until',
    'attempt_generation','attempts','last_attempt_at','last_success_at','last_error'],
});

const tableNames = Object.keys(ORDINARY_FRONTEND_AUTHORITY_TABLES);
const tableSql = tableNames.map(name => {
  const fields = ORDINARY_FRONTEND_AUTHORITY_TABLES[name];
  const projection = fields.map(field => `"${field}"`).join(',');
  const object = fields.map(field => `'${field}',q."${field}"`).join(',');
  return `'${name}',json((SELECT json_group_array(json_object(${object})) FROM (SELECT ${projection} FROM "${name}" ORDER BY ${projection} LIMIT ${LIMIT}) q))`;
}).join(',\n  ');
const schemaNames = [...tableNames, 'native_staff_control_plane_candidates', 'native_staff_lifecycle_control_plane_candidates'];
const schemaList = schemaNames.map(name => `'${name}'`).join(',');
const schemaColumns = schemaNames.map(name => `'${name}',json((SELECT json_group_array(name)
  FROM (SELECT name FROM pragma_table_info('${name}') ORDER BY cid)))`).join(',\n    ');

/** One finite SELECT captures legacy roles, permissions, scopes, native staff
 * bindings and disabled-control state. No caller values enter SQL. */
export const ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY = `SELECT json_object(
  'bridgeMismatchCount',(SELECT count(*) FROM staff_users s LEFT JOIN native_staff_admissions a ON a.staff_id=s.id
    LEFT JOIN native_staff_profiles p ON p.staff_id=s.id WHERE (s.status='active' OR a.staff_id IS NOT NULL)
      AND (a.staff_id IS NULL OR p.staff_id IS NULL OR s.email IS NOT p.login_email COLLATE BINARY
        OR s.access_subject IS NOT a.bound_access_subject OR s.display_name IS NOT p.display_name
        OR s.status IS NOT CASE a.active WHEN 1 THEN 'active' ELSE 'inactive' END)),
  ${tableSql},
  'nativeStaffCohort',json((SELECT json_group_array(json_object('staffId',staffId,'email',email,'accessSubject',accessSubject,
    'displayName',displayName,'legacyStatus',legacyStatus,'bridgeStatus',bridgeStatus,'nativeActive',nativeActive,'admissionVersion',admissionVersion,
    'profileVersion',profileVersion)) FROM (SELECT s.id AS staffId,s.email AS email,s.access_subject AS accessSubject,
    s.display_name AS displayName,s.status AS legacyStatus,
    CASE WHEN a.staff_id IS NULL THEN 'not_admitted' WHEN p.staff_id IS NULL THEN 'profile_missing'
      WHEN s.email IS NOT p.login_email COLLATE BINARY OR s.access_subject IS NOT a.bound_access_subject THEN 'identity_mismatch'
      WHEN s.display_name IS NOT p.display_name THEN 'display_name_mismatch'
      WHEN s.status IS NOT CASE a.active WHEN 1 THEN 'active' ELSE 'inactive' END THEN 'status_mismatch' ELSE 'matched' END AS bridgeStatus,
    a.active AS nativeActive,a.version AS admissionVersion,p.version AS profileVersion
    FROM staff_users s LEFT JOIN native_staff_admissions a ON a.staff_id=s.id LEFT JOIN native_staff_profiles p ON p.staff_id=s.id
    WHERE s.status='active' OR a.staff_id IS NOT NULL ORDER BY s.id LIMIT ${LIMIT}))),
  'controlPlane',json((SELECT json_group_array(json_object('staff_id',staff_id,'bound_access_subject',bound_access_subject,
    'admission_version',admission_version,'profile_version',profile_version))
    FROM (SELECT staff_id,bound_access_subject,admission_version,profile_version
      FROM native_staff_lifecycle_control_plane_candidates ORDER BY staff_id LIMIT ${LIMIT}))),
  'nativeControlCandidates',json((SELECT json_group_array(json_object('staff_id',staff_id,'bound_access_subject',bound_access_subject,
    'admission_version',admission_version,'profile_version',profile_version))
    FROM (SELECT staff_id,bound_access_subject,admission_version,profile_version
      FROM native_staff_control_plane_candidates ORDER BY staff_id LIMIT ${LIMIT}))),
  'schema',json((SELECT json_group_array(json_object('type',type,'name',name,'sql',sql))
    FROM (SELECT type,name,sql FROM sqlite_master WHERE name IN (${schemaList})
      OR substr(name,1,12)='staff_login_' ORDER BY type,name))),
  'schemaColumns',json_object(${schemaColumns})
) AS frontend_authority_snapshot`;

const REQUIRED_SCHEMA_COLUMNS = Object.freeze({
  ...ORDINARY_FRONTEND_AUTHORITY_TABLES,
  native_staff_control_plane_candidates: ['staff_id','bound_access_subject','admission_version','profile_version'],
  native_staff_lifecycle_control_plane_candidates: ['staff_id','bound_access_subject','admission_version','profile_version'],
});
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

export function validateOrdinaryFrontendAuthoritySchemaColumns(columns) {
  const required = Object.keys(REQUIRED_SCHEMA_COLUMNS);
  if (!exact(columns, required)) throw Error('authority_reader_schema_columns_invalid');
  for (const [objectName, fields] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    const actual = columns[objectName];
    if (!Array.isArray(actual) || new Set(actual).size !== actual.length
      || fields.some(field => !actual.includes(field))) throw Error(`authority_reader_schema_column_missing:${objectName}`);
  }
  return columns;
}

export function assertPre226StaffLoginSchema(schema) {
  if (!Array.isArray(schema) || schema.some(row => !row || typeof row.name !== 'string'))
    throw Error('authority_reader_schema_inventory_invalid');
  if (schema.some(row => row.name.startsWith('staff_login_')))
    throw Error('ordinary_frontend_authority_requires_pre0226_staff_login_schema');
}

function parseRows(output) {
  let value;
  try { value = typeof output === 'string' ? JSON.parse(output) : output; } catch { throw Error('authority_reader_json_invalid'); }
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true || !Array.isArray(value[0].results))
    throw Error('authority_reader_result_invalid');
  return value[0].results;
}

/** Read one fresh, exact snapshot through the installed, hash-pinned Wrangler
 * runtime. This function is only called by an explicitly invoked executor. */
export async function readOrdinaryFrontendAuthorityObservation({ review, sourceCommit, read, now = Date.now, env = process.env } = {}) {
  review = structuredClone(review);
  if (!COMMIT.test(sourceCommit ?? '') || review?.sourceCommit !== sourceCommit
    || review.accountId !== NATIVE_STAFF_PRODUCTION_TARGET.accountId || review.databaseId !== NATIVE_STAFF_PRODUCTION_TARGET.databaseId)
    throw Error('authority_reader_target_invalid');
  const environment = read ? null : nativeStaffReadinessEnvironment(env);
  const runtime = path.join(ROOT, 'apps/operations/node_modules/wrangler/wrangler-dist/cli.js');
  if (!read) {
    const profile = JSON.parse(await readFile(path.join(ROOT, 'scripts/production-deploy-profile.json'), 'utf8'));
    if (!SHA.test(profile.wranglerRuntimeSHA256) || hash(await readFile(runtime)) !== profile.wranglerRuntimeSHA256)
      throw Error('authority_reader_runtime_unqualified');
  }
  const target = NATIVE_STAFF_PRODUCTION_TARGET, folder = await mkdtemp(path.join(tmpdir(), 'ordinary-frontend-authority-'));
  const config = path.join(folder, 'wrangler.json');
  try {
    await writeFile(config, JSON.stringify({ name: 'ops-frontend-authority-read-only', account_id: target.accountId,
      compatibility_date: '2026-07-22', d1_databases: [{ binding: 'OPS_DB', database_name: target.databaseName, database_id: target.databaseId }] }),
    { flag: 'wx', mode: 0o600 });
    const reader = read ?? (async args => {
      try { return (await promisify(execFile)(process.execPath, [runtime, ...args], { cwd: folder, env: environment,
        timeout: 45_000, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8', windowsHide: true, shell: false })).stdout; }
      catch { throw Error('authority_reader_read_failed'); }
    });
    const started = now(), selected = parseRows(await reader(['d1','execute',target.databaseId,'--remote','--config',config,
      '--command',ORDINARY_FRONTEND_AUTHORITY_SNAPSHOT_QUERY,'--json'], { cwd: folder }));
    if (selected.length !== 1 || typeof selected[0].frontend_authority_snapshot !== 'string'
      || Buffer.byteLength(selected[0].frontend_authority_snapshot) > 20 * 1024 * 1024 || now() - started > 60_000)
      throw Error('authority_reader_snapshot_invalid');
    let snapshot;
    try { snapshot = JSON.parse(selected[0].frontend_authority_snapshot); } catch { throw Error('authority_reader_snapshot_invalid'); }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Array.isArray(snapshot.schema))
      throw Error('authority_reader_snapshot_invalid');
    const schema = snapshot.schema;
    assertPre226StaffLoginSchema(schema);
    const columns = validateOrdinaryFrontendAuthoritySchemaColumns(snapshot.schemaColumns);
    delete snapshot.schema; delete snapshot.schemaColumns;
    const schemaSha256 = hash(canonicalStaffReadiness({ definitions: schema, columns }));
    return { schemaVersion: 1, accountId: target.accountId, databaseId: target.databaseId,
      observedAt: new Date(started).toISOString(), snapshot: { schemaSha256,
        bridgeMismatchCount: snapshot.bridgeMismatchCount, nativeStaffCohort: snapshot.nativeStaffCohort,
        controlPlane: snapshot.controlPlane, nativeControlCandidates: snapshot.nativeControlCandidates,
        tables: Object.fromEntries(tableNames.map(name => [name, snapshot[name]])) } };
  } finally { await unlink(config).catch(() => {}); await rmdir(folder).catch(() => {}); }
}
