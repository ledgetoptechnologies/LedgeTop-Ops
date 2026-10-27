import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertNativeStaffAccessGroupStateMatches, validateNativeStaffAccessGroupObservation } from './native-staff-cutover-access-group-observation.mjs';

const fail = code => { throw new Error(`native_staff_cutover_${code}`); };
const SHA = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLAN_KIND = 'operations-native-staff-cutover-v1';
const BINDING_KIND = 'operations-native-staff-binding-review-v1';
const REVIEWED_MIGRATION_NAMES_SHA256 = 'c71f757e5f75e4ad9326db9175a02635cf5cecbfb06e6dfba7e6a856cb75b854';
const REVIEWED_MIGRATION_CONTENTS_SHA256 = '0e43023eb3ddb1739e6a15d1050b6b512cb4afcda7cfb9545b5d6b47f2a1c3f5';
const REVIEWED_LOCAL_SUCCESSOR = Object.freeze({
  name: '0231_owner_google_ads_summary.sql',
  sha256: 'd1c778d0e10a21b25663f89783ceb7ace664e4d70eb2b5e121375e6ef1f80481',
});
const LEGACY_TABLES = new Set(['staff_users','staff_divisions','permissions','roles','role_permissions',
  'staff_role_assignments','staff_permission_overrides','local_staff_role_assignments']);
const AUTHORITY_WIDE_TABLES = new Set(['native_business_areas','native_business_divisions',
  'native_directory_resource_scopes','native_staff_authority_capabilities','native_staff_access_reconciliation',
  'staff_login_binding_control','native_staff_delegation_ceilings']);
const ID_COLUMNS = new Set(['staff_id','actor_staff_id','target_staff_id','granted_by','admitted_by','created_by',
  'approved_by_staff_id','operator_staff_id','approved_operator_staff_id','issued_by_staff_id','owner_staff_id',
  'beneficiary_staff_id','selected_by_staff_id','reviewed_by_staff_id','terminal_by_staff_id','created_by_staff_id']);
const PREPARED = new WeakMap();
const MAX_SNAPSHOT_GUARD_TERMS = 8;
const MAX_SNAPSHOT_GUARD_SQL_BYTES = 80_000;
const MAX_SNAPSHOT_GUARD_PARAMS = 100;
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value === null || typeof value !== 'object' ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const qid = value => {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) fail('schema_invalid');
  return `"${value}"`;
};
const sqlText = value => `'${String(value).replaceAll("'", "''")}'`;
const own = (value, keys) => exact(value, keys);
async function all(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  if (result?.success !== true || !Array.isArray(result.results)) fail('snapshot_read_failed');
  return result.results;
}
const validSubject = value => typeof value === 'string' && value.length > 0 && value.length <= 191
  && value === value.trim() && !/\p{C}/u.test(value);
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function cloneCanonical(value) {
  let encoded;
  try { encoded = canonical(value); } catch { fail('artifact_invalid'); }
  let cloned;
  try { cloned = JSON.parse(encoded); } catch { fail('artifact_invalid'); }
  if (canonical(cloned) !== encoded) fail('artifact_invalid');
  return cloned;
}

function parseSnapshot(reviewedSnapshot) {
  if (!exact(reviewedSnapshot, ['snapshotJson','snapshotSha256','migrationNames','migrationNamesSha256','currentStaffCount','controlPlaneStaffIds'])
    || typeof reviewedSnapshot.snapshotJson !== 'string' || !SHA.test(reviewedSnapshot.snapshotSha256 ?? '')
    || sha(reviewedSnapshot.snapshotJson) !== reviewedSnapshot.snapshotSha256) fail('snapshot_invalid');
  let snapshot;
  try { snapshot = JSON.parse(reviewedSnapshot.snapshotJson); } catch { fail('snapshot_invalid'); }
  if (!exact(snapshot, ['schema_count','schema','ledger','rows']) || !Array.isArray(snapshot.schema)
    || !Array.isArray(snapshot.ledger) || !snapshot.rows || typeof snapshot.rows !== 'object' || Array.isArray(snapshot.rows)) fail('snapshot_invalid');
  return snapshot;
}

async function cutoverSchemaModel(db) {
  const schema = await all(db, `SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA')
      AND type IN ('table','view','index','trigger') ORDER BY type,name`);
  const columnRows = await all(db, `SELECT s.name table_name,p.name column_name FROM sqlite_schema s
    JOIN pragma_table_info(s.name) p WHERE s.type='table' AND s.name NOT LIKE 'sqlite_%'
      AND s.name NOT IN ('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY s.name,p.cid`);
  const tables = new Map(schema.filter(row => row.type === 'table' && row.name !== 'd1_migrations').map(row => [row.name, []]));
  for (const row of columnRows) tables.get(row.table_name)?.push(row.column_name);
  if (!schema.some(row => row.type === 'table' && row.name === 'd1_migrations')) fail('migration_ledger_missing');
  tables.set('d1_migrations',['name']);
  return { schema, tables };
}

function tableStateExpression(table, columns, idsJson) {
  const selectedColumns = table === 'staff_users' ? columns.filter(column => column !== 'last_seen_at') : columns;
  let predicate = '';
  let parameters = [];
  if (!LEGACY_TABLES.has(table) && !AUTHORITY_WIDE_TABLES.has(table)) {
    const references = columns.filter(column => ID_COLUMNS.has(column) || /(?:staff|user)_id$/u.test(column));
    if (!references.length) return null;
    predicate = ` WHERE ${references.map(column => `${qid(column)} IN (SELECT value FROM json_each(?))`).join(' OR ')}`;
    parameters = references.map(() => idsJson);
  }
  const pairs = selectedColumns.map(column => `${sqlText(column)},${qid(column)}`).join(',');
  const query = `SELECT ${selectedColumns.map(qid).join(',')} FROM ${qid(table)}${predicate} ORDER BY ${selectedColumns.map(qid).join(',')}`;
  return { expression:`json((SELECT json_group_array(json_object(${pairs})) FROM (${query})))`, params:parameters };
}

/** Keep the D1 target at the frozen 0230 snapshot. A later source-tree file is
 * admitted only as the single independently reviewed, byte-pinned 0231 Ads
 * successor; it is never included in the cutover target ledger or plan. */
export function assertNativeStaffCutoverMigrationSource({targetNames,localNames,readMigrationBytes}={}) {
  if(!Array.isArray(targetNames)||!Array.isArray(localNames)||typeof readMigrationBytes!=='function')fail('migration_chain_mismatch');
  const reviewedPrefix = localNames.slice(0, 230);
  const hasOnlyReviewedSourceSuffix = localNames.length === 230
    || localNames.length === 231 && localNames[230] === REVIEWED_LOCAL_SUCCESSOR.name;
  if (!hasOnlyReviewedSourceSuffix || reviewedPrefix.length !== 230 || reviewedPrefix.at(-1) !== '0230_app_release_pilot.sql'
    || sha(reviewedPrefix.join('\n')) !== REVIEWED_MIGRATION_NAMES_SHA256 || canonical(reviewedPrefix) !== canonical(targetNames)) fail('migration_chain_mismatch');
  const contentHash = sha(reviewedPrefix.map(name => `${name}\0${sha(readMigrationBytes(name))}`).join('\n'));
  if (contentHash !== REVIEWED_MIGRATION_CONTENTS_SHA256) fail('migration_contents_changed');
  if (localNames.length === 231 && sha(readMigrationBytes(REVIEWED_LOCAL_SUCCESSOR.name)) !== REVIEWED_LOCAL_SUCCESSOR.sha256) {
    fail('migration_contents_changed');
  }
  return true;
}

function verifyMigrationSource(names) {
  const directory = fileURLToPath(new URL('../apps/operations/migrations/', import.meta.url));
  const localNames = [...readdirSync(directory)].filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
  assertNativeStaffCutoverMigrationSource({targetNames:names,localNames,
    readMigrationBytes:name=>readFileSync(path.join(directory,name))});
}

/** Read the exact 0230 source snapshot. This intentionally does not call the
 * older bootstrap helper, whose source contract ends at migration 0225. */
export async function readNativeStaffCutoverSnapshot(db) {
  if (!db || typeof db.prepare !== 'function') fail('database_invalid');
  const model = await cutoverSchemaModel(db);
  const users = await all(db,'SELECT id FROM staff_users ORDER BY id');
  const ids = [...new Set(users.map(row => row.id))].sort();
  if (!ids.length || ids.some(id => typeof id !== 'string' || !id.length || id.length > 191)) fail('cohort_invalid');
  const idsJson = JSON.stringify(ids);
  const queries = [
    { key:'schema_count', sql:`SELECT json_array(count(*)) AS value FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      AND name NOT IN ('_cf_KV','_cf_METADATA') AND type IN ('table','view','index','trigger')`, params:[] },
    { key:'ledger', sql:`SELECT json((SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY name))) AS value`, params:[] },
  ];
  for (let offset=0;offset<model.schema.length;offset+=20) {
    const objectNames=JSON.stringify(model.schema.slice(offset,offset+20).map(row=>row.name));
    queries.push({key:`schema:${offset/20}`,sql:`SELECT coalesce(json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)),'[]') AS value
      FROM (SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (SELECT value FROM json_each(?)) ORDER BY type,name)`,params:[objectNames]});
  }
  const stateTables=[...model.tables.keys()].filter(name=>name!=='d1_migrations').sort();
  for(let offset=0;offset<stateTables.length;offset+=20){
    const chunks=stateTables.slice(offset,offset+20),entries=[];
    for(const name of chunks){const expression=tableStateExpression(name,model.tables.get(name),idsJson);if(expression)entries.push({name,...expression});}
    const jsonObject=entries.map(entry=>`${JSON.stringify(entry.name)},${entry.expression}`).join(',');
    const orderedParams=[idsJson,...entries.flatMap(entry=>entry.params)];
    queries.push({key:`rows:${offset/20}`,sql:`WITH selected_ids(value) AS (SELECT value FROM json_each(?)) SELECT json_object(${jsonObject}) AS value`,params:orderedParams});
  }
  const results=await db.batch(queries.map(query=>db.prepare(query.sql).bind(...query.params)));
  if(!Array.isArray(results)||results.length!==queries.length||results.some(result=>result?.success!==true
    ||!Array.isArray(result.results)||typeof result.results[0]?.value!=='string'))fail('snapshot_invalid');
  const values=new Map(queries.map((query,index)=>[query.key,JSON.parse(results[index].results[0].value)]));
  const rows={};for(let i=0;values.has(`rows:${i}`);i++)Object.assign(rows,values.get(`rows:${i}`));
  const schema=[];for(let i=0;values.has(`schema:${i}`);i++)schema.push(...values.get(`schema:${i}`));
  const snapshot=JSON.stringify({schema_count:values.get('schema_count')?.[0],schema,ledger:values.get('ledger'),rows});
  if(Buffer.byteLength(snapshot)>32*1024*1024)fail('snapshot_too_large');
  const migrations=values.get('ledger');
  if(!Array.isArray(migrations)||migrations.length!==230||migrations.at(-1)!=='0230_app_release_pilot.sql'
    ||migrations.some((name,index)=>!new RegExp(`^${String(index+1).padStart(4,'0')}_.*\\.sql$`,'u').test(name)))fail('migration_chain_mismatch');
  verifyMigrationSource(migrations);
  const controlPlaneStaffIds=(await all(db,'SELECT staff_id FROM native_staff_lifecycle_control_plane_candidates ORDER BY staff_id')).map(row=>row.staff_id);
  const migrationNamesSha256=sha(migrations.join('\n'));
  return Object.freeze({snapshotJson:snapshot,snapshotSha256:sha(snapshot),migrationNames:Object.freeze(migrations),
    migrationNamesSha256,currentStaffCount:users.length,controlPlaneStaffIds:Object.freeze(controlPlaneStaffIds)});
}

function currentCohort(snapshot) {
  const users = snapshot.rows.staff_users, admissions = snapshot.rows.native_staff_admissions ?? [];
  const profiles = snapshot.rows.native_staff_profiles ?? [];
  if (!Array.isArray(users) || !Array.isArray(admissions) || !Array.isArray(profiles)) fail('cohort_invalid');
  const admissionById = new Map(admissions.map(row => [row.staff_id, row]));
  const profileById = new Map(profiles.map(row => [row.staff_id, row]));
  const selected = users.flatMap(staff => {
    const admission = admissionById.get(staff.id), profile = profileById.get(staff.id);
    if (staff.status !== 'active' && !admission) return [];
    if (!admission || !profile || !ID.test(staff.id ?? '') || !validSubject(admission.bound_access_subject)
      || typeof profile.login_email !== 'string' || !profile.login_email || profile.login_email !== profile.login_email.trim().toLowerCase()
      || typeof profile.display_name !== 'string' || !profile.display_name.trim()
      || typeof admission.active !== 'number' || ![0,1].includes(admission.active)
      || !Number.isSafeInteger(admission.version) || admission.version < 1
      || !Number.isSafeInteger(profile.version) || profile.version < 1
      || staff.email !== profile.login_email || staff.display_name !== profile.display_name
      || staff.access_subject !== admission.bound_access_subject
      || staff.status !== (admission.active === 1 ? 'active' : 'inactive')) {
      // Keep failure categories field-free; never echo identity material.
      fail('cohort_bridge_mismatch');
    }
    return [{ staffId: staff.id, email: profile.login_email, accessSubject: admission.bound_access_subject,
      displayName: profile.display_name, active: admission.active === 1,
      admissionVersion: admission.version, profileVersion: profile.version }];
  }).sort((a,b) => a.staffId.localeCompare(b.staffId));
  if (!selected.length || new Set(selected.map(row => row.staffId)).size !== selected.length
    || new Set(selected.map(row => row.email)).size !== selected.length
    || new Set(selected.map(row => row.accessSubject)).size !== selected.length) fail('cohort_ambiguous');
  return selected;
}

function validateControl(snapshot) {
  const rows = snapshot.rows.native_staff_access_reconciliation;
  if (!Array.isArray(rows) || rows.length !== 1) fail('control_missing_or_ambiguous');
  const row = rows[0];
  if (row.singleton !== 1 || row.enabled !== 0 || row.generation !== 0 || row.applied_generation !== 0
    || row.lease_id !== null || row.lease_until !== null || row.attempt_generation !== null
    || row.last_success_at !== null || row.last_error !== null) fail('control_not_dormant');
}

const PREPARATION_KEYS = ['schemaVersion','kind','accountId','workerName','environment','databaseId',
  'activeRuntimeVersion','candidateRuntimeVersion','activeSettingsSha256','candidateSettingsSha256','bindingsSha256',
  'activeModuleSha256','candidateModuleSha256','activeSourceCommit','candidateSourceCommit','controlState',
  'candidateSourceTreeSha256','sourceEvidenceSha256','behaviorQualificationSha256','testReportSha256','builtModuleSha256','qualificationRunnerSha256',
  'cohortSha256','activeStaffCount','activeAlternateBindingCount','alternateBindingEvidenceSha256','accessGroupObservations',
  'currentGroupCount','currentGroupSha256','desiredGroupCount','desiredGroupSha256','receiptSha256'];

function validatePreparationReceipt(value, compiled) {
  if (!exact(value, PREPARATION_KEYS) || value.schemaVersion !== 1
    || value.kind !== 'operations-native-staff-sync-dormant-preparation-v1'
    || !/^[a-f0-9]{32}$/u.test(value.accountId ?? '')
    || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.workerName ?? '')
    || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.environment ?? '')
    || !/^[a-f0-9-]{36}$/u.test(value.databaseId ?? '')
    || !['missing','disabled'].includes(value.controlState)
    || value.cohortSha256 !== compiled.plan.cohortSha256
    || value.activeStaffCount !== compiled.cohort.filter(row=>row.active).length
    || ![value.activeSettingsSha256,value.candidateSettingsSha256,value.bindingsSha256,value.activeModuleSha256,
      value.candidateModuleSha256,value.alternateBindingEvidenceSha256,value.currentGroupSha256,value.desiredGroupSha256]
      .every(hash=>SHA.test(hash ?? ''))
    || !/^[0-9a-f]{40}$/u.test(value.activeSourceCommit ?? '')
    || !/^[0-9a-f]{40}$/u.test(value.candidateSourceCommit ?? '')
    || !['candidateSourceTreeSha256','sourceEvidenceSha256','behaviorQualificationSha256','testReportSha256','builtModuleSha256','qualificationRunnerSha256']
      .every(key=>SHA.test(value[key]??''))
    || value.builtModuleSha256!==value.candidateModuleSha256
    || !['activeStaffCount','activeAlternateBindingCount','currentGroupCount','desiredGroupCount']
      .every(key=>Number.isSafeInteger(value[key]) && value[key]>=0)) fail('sync_preparation_invalid');
  if (!exact(value.accessGroupObservations, ['before','after'])) fail('access_group_observation_invalid');
  let before, after;
  try {
    before = validateNativeStaffAccessGroupObservation(value.accessGroupObservations.before);
    after = validateNativeStaffAccessGroupObservation(value.accessGroupObservations.after);
    assertNativeStaffAccessGroupStateMatches(before, after);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('native_staff_access_group_')) fail('access_group_observation_invalid');
    throw error;
  }
  if (before.accountId !== value.accountId || after.accountId !== value.accountId
    || value.currentGroupCount !== before.managedEmailCount || value.currentGroupCount !== after.managedEmailCount
    || value.currentGroupSha256 !== before.managedEmailsSha256 || value.currentGroupSha256 !== after.managedEmailsSha256)
    fail('access_group_observation_mismatch');
  const beforeAt=Date.parse(before.observedAt),afterAt=Date.parse(after.observedAt);
  if(beforeAt>afterAt||afterAt-beforeAt>60*60_000)fail('access_group_observation_window_invalid');
  const { receiptSha256, ...body } = value;
  if (!SHA.test(receiptSha256 ?? '') || sha(canonical(body)) !== receiptSha256) fail('sync_preparation_digest_invalid');
  return cloneCanonical(value);
}

/** Compile the exact receipt shape consumed by the production readiness verifier.
 * This does not issue owner approval or mutate D1. */
export function compileNativeStaffCutoverV1({ reviewedSnapshot, controlPlaneStaffIds, operator, syncPreparationReceipt }) {
  const snapshot = parseSnapshot(reviewedSnapshot);
  validateControl(snapshot);
  const cohort = currentCohort(snapshot);
  if (!Array.isArray(controlPlaneStaffIds) || !controlPlaneStaffIds.length
    || new Set(controlPlaneStaffIds).size !== controlPlaneStaffIds.length
    || controlPlaneStaffIds.some(id => !ID.test(id) || !cohort.some(row => row.staffId === id && row.active))) fail('control_plane_invalid');
  const sortedControlPlane = [...controlPlaneStaffIds].sort();
  const expectedControlPlane = [...reviewedSnapshot.controlPlaneStaffIds].sort();
  if (canonical(sortedControlPlane) !== canonical(expectedControlPlane)) fail('control_plane_snapshot_mismatch');
  if (!exact(operator, ['staffId','accessSubject']) || !ID.test(operator.staffId ?? '')
    || !validSubject(operator.accessSubject)
    || !sortedControlPlane.includes(operator.staffId)
    || !cohort.some(row => row.staffId === operator.staffId && row.accessSubject === operator.accessSubject && row.active)) fail('operator_invalid');
  const cohortSha256 = sha(canonical(cohort));
  const plan = { kind: PLAN_KIND, cohortSha256, controlPlaneStaffIds: sortedControlPlane };
  const binding = { kind: BINDING_KIND, cohortSha256, operatorStaffId: operator.staffId, operatorSubject: operator.accessSubject };
  const preparation = validatePreparationReceipt(syncPreparationReceipt, { plan:{cohortSha256}, cohort });
  return Object.freeze({ schemaVersion: 1, plan, binding, canonicalPlanJson: canonical(plan),
    bindingEvidenceJson: canonical(binding), planSha256: sha(canonical(plan)), bindingSha256: sha(canonical(binding)),
    reviewedSnapshot, cohort, controlPlaneStaffIds: Object.freeze(sortedControlPlane), operator: Object.freeze({ ...operator }),
    syncPreparationReceipt:preparation });
}

function tableStateSql(table, columns, idsJson) {
  const stateColumns = table === 'staff_users' ? columns.filter(column => column !== 'last_seen_at') : columns;
  let predicate = '';
  if (!LEGACY_TABLES.has(table) && !AUTHORITY_WIDE_TABLES.has(table)) {
    const references = columns.filter(column => ID_COLUMNS.has(column) || /(?:staff|user)_id$/u.test(column));
    if (!references.length) return null;
    predicate = ` WHERE ${references.map(column => `${qid(column)} IN (SELECT value FROM json_each(${sqlText(idsJson)}))`).join(' OR ')}`;
  }
  const selected = stateColumns.map(column => `${sqlText(column)},${qid(column)}`).join(',');
  const from = `SELECT ${stateColumns.map(qid).join(',')} FROM ${qid(table)}${predicate} ORDER BY ${stateColumns.map(qid).join(',')}`;
  return `json((SELECT json_group_array(json_object(${selected})) FROM (${from})))`;
}

async function snapshotGuards(db, reviewedSnapshot) {
  const expected = parseSnapshot(reviewedSnapshot);
  const schemaRows = await db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA')
      AND type IN ('table','view','index','trigger') ORDER BY type,name`).all();
  if (schemaRows?.success !== true || !Array.isArray(schemaRows.results)) fail('snapshot_schema_read_failed');
  const modelRows = schemaRows.results;
  const colRows = await db.prepare(`SELECT s.name table_name,p.name column_name FROM sqlite_schema s
    JOIN pragma_table_info(s.name) p WHERE s.type='table' AND s.name NOT LIKE 'sqlite_%'
      AND s.name NOT IN ('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY s.name,p.cid`).all();
  if (colRows?.success !== true || !Array.isArray(colRows.results)) fail('snapshot_columns_read_failed');
  const tables = new Map();
  for (const row of modelRows.filter(row => row.type === 'table' && row.name !== 'd1_migrations')) tables.set(row.name, []);
  for (const row of colRows.results) tables.get(row.table_name)?.push(row.column_name);
  tables.set('d1_migrations', ['name']);
  const statements = [{ key:'schema_count', condition:`(SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
      AND name NOT IN ('_cf_KV','_cf_METADATA') AND type IN ('table','view','index','trigger'))=?`,
    error:'native-staff-cutover-schema-mismatch', params:[expected.schema_count] }];
  for (let offset = 0; offset < expected.schema.length; offset += 20) {
    const chunk = expected.schema.slice(offset, offset + 20);
    statements.push({ key:`schema:${offset}`, condition:`NOT EXISTS(SELECT 1 FROM json_each(?) expected
      WHERE NOT EXISTS(SELECT 1 FROM sqlite_schema current WHERE current.type=json_extract(expected.value,'$.type')
        AND current.name=json_extract(expected.value,'$.name') AND current.tbl_name IS json_extract(expected.value,'$.tbl_name')
        AND current.sql IS json_extract(expected.value,'$.sql')))` , error:'native-staff-cutover-schema-mismatch',
      params:[JSON.stringify(chunk)] });
  }
  const ledger = JSON.stringify(expected.ledger);
  statements.push({ key:'ledger', condition:`json((SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY name))) IS ?`,
    error:'native-staff-cutover-ledger-mismatch', params:[ledger] });
  const idsJson = JSON.stringify((expected.rows.staff_users ?? []).map(row => row.id).sort());
  for (const [table, columns] of [...tables.entries()].sort(([a],[b]) => a.localeCompare(b))) {
    if (table === 'd1_migrations') continue;
    const state = tableStateSql(table, columns, idsJson);
    if (!state) continue;
    const expectedRows = JSON.stringify(expected.rows[table] ?? []);
    statements.push({ key:`rows:${table}`, condition:`${state} IS ?`, error:'native-staff-cutover-rows-mismatch', params:[expectedRows] });
  }
  const controlPlane = JSON.stringify([...reviewedSnapshot.controlPlaneStaffIds].sort());
  statements.push({ key:'control_plane', condition:`coalesce((SELECT json_group_array(staff_id) FROM
      (SELECT staff_id FROM native_staff_lifecycle_control_plane_candidates ORDER BY staff_id)),'[]') IS ?`,
    error:'native-staff-cutover-control-plane-mismatch', params:[controlPlane] });
  return packSnapshotGuards(statements);
}

function snapshotGuardSql(guards) {
  let expression = '1';
  for (let index = guards.length - 1; index >= 0; index -= 1) {
    const guard = guards[index];
    expression = `CASE WHEN (${guard.condition}) THEN (${expression}) ELSE json(${sqlText(guard.error)}) END`;
  }
  return `SELECT ${expression} AS verified`;
}

function packSnapshotGuards(logicalGuards) {
  const packed = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const sql = snapshotGuardSql(current);
    packed.push({ key:current.map(guard => guard.key).join('+'), sql,
      params:current.flatMap(guard => guard.params) });
    current = [];
  };
  for (const guard of logicalGuards) {
    if (!guard || typeof guard.key !== 'string' || typeof guard.condition !== 'string'
      || !Array.isArray(guard.params) || !/^native-staff-cutover-[a-z-]+-mismatch$/u.test(guard.error)) fail('snapshot_guard_invalid');
    const singleSql = snapshotGuardSql([guard]);
    if (new TextEncoder().encode(singleSql).byteLength > MAX_SNAPSHOT_GUARD_SQL_BYTES
      || guard.params.length > MAX_SNAPSHOT_GUARD_PARAMS) fail('snapshot_guard_oversized');
    const candidate = [...current, guard];
    const candidateSql = snapshotGuardSql(candidate);
    const candidateParams = candidate.reduce((count, item) => count + item.params.length, 0);
    if (current.length && (candidate.length > MAX_SNAPSHOT_GUARD_TERMS
      || new TextEncoder().encode(candidateSql).byteLength > MAX_SNAPSHOT_GUARD_SQL_BYTES
      || candidateParams > MAX_SNAPSHOT_GUARD_PARAMS)) flush();
    const nextSql = snapshotGuardSql([...current, guard]);
    const nextParams = current.reduce((count, item) => count + item.params.length, guard.params.length);
    if (current.length >= MAX_SNAPSHOT_GUARD_TERMS || new TextEncoder().encode(nextSql).byteLength > MAX_SNAPSHOT_GUARD_SQL_BYTES
      || nextParams > MAX_SNAPSHOT_GUARD_PARAMS) fail('snapshot_guard_oversized');
    current.push(guard);
  }
  flush();
  return packed;
}

function compileWrites(prepared) {
  const { approval, commandId, canonicalPlanJson, planSha256, bindingEvidenceJson, bindingSha256 } = prepared;
  const timeGate = `CASE WHEN julianday(?)<=julianday('now') AND julianday(?)>julianday('now')
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=?)
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=? OR approval_id=?)
    THEN ? ELSE NULL END`;
  const approvalInsert = { sql:`INSERT INTO native_staff_bootstrap_approvals(approval_id,canonical_plan_json,canonical_plan_sha256,
      approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,
      independent_binding_verification_sha256,issued_by_staff_id,issued_by_access_subject,issued_at,expires_at,revoked_at)
    SELECT ${timeGate},?,?,?,?,?,?,?,?,?,?,NULL`, params:[approval.issuedAt,approval.expiresAt,approval.approvalId,commandId,approval.approvalId,
      approval.approvalId,canonicalPlanJson,planSha256,approval.operatorStaffId,approval.operatorSubject,bindingEvidenceJson,bindingSha256,
      approval.operatorStaffId,approval.operatorSubject,approval.issuedAt,approval.expiresAt] };
  const enable = { sql:`UPDATE native_staff_access_reconciliation SET enabled=1
    WHERE singleton=1 AND enabled=0 AND generation=0 AND applied_generation=0 AND lease_id IS NULL
      AND lease_until IS NULL AND attempt_generation IS NULL AND last_success_at IS NULL AND last_error IS NULL` , params:[] };
  const resultJson = expectedResultJson(prepared);
  const resultSha256 = sha(resultJson);
  const receipt = { sql:`INSERT INTO native_staff_bootstrap_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,
      canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256)
    SELECT CASE WHEN EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=? AND revoked_at IS NULL
      AND issued_at=? AND expires_at=?) AND EXISTS(SELECT 1 FROM native_staff_access_reconciliation
      WHERE singleton=1 AND enabled=1 AND generation=0 AND applied_generation=0 AND lease_id IS NULL)
      THEN ? ELSE NULL END,?,?,?,?,?,?,?,?,?`,
    params:[approval.approvalId,approval.issuedAt,approval.expiresAt,commandId,approval.approvalId,approval.operatorStaffId,approval.operatorSubject,
      canonicalPlanJson,planSha256,bindingEvidenceJson,bindingSha256,resultJson,resultSha256] };
  return [approvalInsert,enable,receipt];
}

function expectedResultJson(prepared) {
  return canonical({ schemaVersion:1, action:'native-staff-cutover', cohortSha256:prepared.plan.cohortSha256,
    controlPlaneStaffIds:prepared.controlPlaneStaffIds, sourceSnapshotSha256:prepared.reviewedSnapshot.snapshotSha256,
    syncPreparationReceiptSha256:prepared.syncPreparationReceipt.receiptSha256,
    currentGroupSha256:prepared.syncPreparationReceipt.currentGroupSha256,
    desiredGroupSha256:prepared.syncPreparationReceipt.desiredGroupSha256,
    currentGroupCount:prepared.syncPreparationReceipt.currentGroupCount,
    desiredGroupCount:prepared.syncPreparationReceipt.desiredGroupCount,
    accessGroupObservations:prepared.syncPreparationReceipt.accessGroupObservations,
    generation:0, enabled:1 });
}

/** Prepare a one-use cutover artifact. `verifyApproval` must validate the
 * separately issued owner signature and exact target/source/snapshot bindings. */
export async function prepareNativeStaffCutoverD1(input, { db, verifyApproval, readSnapshot = readNativeStaffCutoverSnapshot } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof verifyApproval !== 'function') fail('executor_unavailable');
  const keys = ['schemaVersion','approval','commandId','canonicalPlanJson','bindingEvidenceJson','reviewedSnapshot',
    'controlPlaneStaffIds','operator','syncPreparationReceipt','trustEnvelope'];
  if (!own(input, keys) || input.schemaVersion !== 1 || !UUID.test(input.approval?.approvalId ?? '')
    || !ID.test(input.commandId ?? '') || typeof input.canonicalPlanJson !== 'string' || typeof input.bindingEvidenceJson !== 'string'
    || !exact(input.approval,['approvalId','operatorStaffId','operatorSubject','issuedAt','expiresAt'])
    || !exact(input.operator,['staffId','accessSubject']) || !Array.isArray(input.controlPlaneStaffIds)
    || typeof input.approval.issuedAt !== 'string' || typeof input.approval.expiresAt !== 'string') fail('artifact_invalid');
  input = cloneCanonical(input);
  let plan, binding;
  try { plan = JSON.parse(input.canonicalPlanJson); binding = JSON.parse(input.bindingEvidenceJson); } catch { fail('artifact_json_invalid'); }
  if (canonical(plan) !== input.canonicalPlanJson || canonical(binding) !== input.bindingEvidenceJson
    || !exact(plan,['kind','cohortSha256','controlPlaneStaffIds']) || plan.kind !== PLAN_KIND || !SHA.test(plan.cohortSha256 ?? '')
    || !Array.isArray(plan.controlPlaneStaffIds)
    || !exact(binding,['kind','cohortSha256','operatorStaffId','operatorSubject']) || binding.kind !== BINDING_KIND
    || binding.cohortSha256 !== plan.cohortSha256 || binding.operatorStaffId !== input.approval.operatorStaffId
    || binding.operatorSubject !== input.approval.operatorSubject) fail('plan_binding_invalid');
  const compiled = compileNativeStaffCutoverV1({ reviewedSnapshot:input.reviewedSnapshot,
    controlPlaneStaffIds:input.controlPlaneStaffIds,operator:{staffId:input.operator.staffId,accessSubject:input.operator.accessSubject},
    syncPreparationReceipt:input.syncPreparationReceipt });
  if (compiled.canonicalPlanJson !== input.canonicalPlanJson || compiled.bindingEvidenceJson !== input.bindingEvidenceJson
    || compiled.operator.staffId !== input.approval.operatorStaffId || compiled.operator.accessSubject !== input.approval.operatorSubject
    || input.trustEnvelope == null || !Number.isFinite(Date.parse(input.approval.issuedAt))
    || !Number.isFinite(Date.parse(input.approval.expiresAt)) || Date.parse(input.approval.issuedAt) > Date.now()
    || Date.parse(input.approval.expiresAt) <= Date.now() || Date.parse(input.approval.expiresAt)-Date.parse(input.approval.issuedAt)>10*60*1000)
    fail('approval_binding_invalid');
  const cutoverApprovalContext = { schemaVersion:1, kind:'operations-native-staff-cutover-approval-context-v1',
    commandId:input.commandId, approvalId:input.approval.approvalId, sourceSnapshotSha256:compiled.reviewedSnapshot.snapshotSha256,
    planSha256:compiled.planSha256, bindingSha256:compiled.bindingSha256, cohortSha256:compiled.plan.cohortSha256,
    controlPlaneStaffIds:compiled.controlPlaneStaffIds, operatorStaffId:input.operator.staffId,
    operatorSubject:input.operator.accessSubject, syncPreparationReceipt:compiled.syncPreparationReceipt };
  const cutoverApprovalContextSha256 = sha(canonical(cutoverApprovalContext));
  if (!await verifyApproval({ input, cutoverApprovalContext, cutoverApprovalContextSha256,
    planSha256:compiled.planSha256, bindingSha256:compiled.bindingSha256,
    snapshotSha256:compiled.reviewedSnapshot.snapshotSha256 })) fail('approval_invalid');
  const live = await readSnapshot(db);
  if (!live || live.snapshotSha256 !== compiled.reviewedSnapshot.snapshotSha256 || live.snapshotJson !== compiled.reviewedSnapshot.snapshotJson
    || canonical([...live.controlPlaneStaffIds].sort()) !== canonical([...compiled.controlPlaneStaffIds].sort())) fail('snapshot_changed');
  const snapshot = parseSnapshot(live);
  validateControl(snapshot);
  const prepared = deepFreeze({ ...input, ...compiled, plan, binding, cutoverApprovalContext,
    cutoverApprovalContextSha256, planSha256:compiled.planSha256, bindingSha256:compiled.bindingSha256 });
  PREPARED.set(prepared, prepared);
  return prepared;
}

/** Commit the first reviewed cohort handoff and default-off control transition
 * together. No identity/role/grant row is changed by this executor. */
export async function executeNativeStaffCutoverD1(db, prepared, { verifyApproval, readSnapshot = readNativeStaffCutoverSnapshot,
  beforeMutationDispatch } = {}) {
  if (!db || typeof db.batch !== 'function' || typeof verifyApproval !== 'function' || !prepared || PREPARED.get(prepared) !== prepared)
    fail('prepared_artifact_invalid');
  if (beforeMutationDispatch !== undefined && typeof beforeMutationDispatch !== 'function') fail('dispatch_hook_invalid');
  const live = await readSnapshot(db);
  if (!live || live.snapshotSha256 !== prepared.reviewedSnapshot.snapshotSha256 || live.snapshotJson !== prepared.reviewedSnapshot.snapshotJson
    || canonical([...live.controlPlaneStaffIds].sort()) !== canonical([...prepared.controlPlaneStaffIds].sort())) fail('snapshot_changed');
  if (!await verifyApproval({ input:prepared, cutoverApprovalContext:prepared.cutoverApprovalContext,
    cutoverApprovalContextSha256:prepared.cutoverApprovalContextSha256,
    planSha256:prepared.planSha256, bindingSha256:prepared.bindingSha256,
    snapshotSha256:prepared.reviewedSnapshot.snapshotSha256 })) fail('approval_revoked');
  const guards = await snapshotGuards(db, prepared.reviewedSnapshot);
  const writes = compileWrites(prepared);
  // Registry implementations can durably consume/mark uncertainty before the
  // one exact batch that contains the approval, enable CAS, and receipt. This
  // hook is deliberately after all live checks and immediately before that
  // batch; it cannot alter or skip the D1 guard statements.
  if (beforeMutationDispatch) await beforeMutationDispatch(Object.freeze({schemaVersion:1,
    commandId:prepared.commandId,approvalId:prepared.approval.approvalId,snapshotSha256:prepared.reviewedSnapshot.snapshotSha256,
    planSha256:prepared.planSha256,bindingSha256:prepared.bindingSha256}));
  let result;
  try { result = await db.batch([...guards,...writes].map(statement => db.prepare(statement.sql).bind(...statement.params))); }
  catch { fail('atomic_batch_refused'); }
  if (!Array.isArray(result) || result.length !== guards.length + writes.length
    || result.some(row => row?.success !== true)
    || result.slice(0,guards.length).some(row => row.results?.[0]?.verified !== 1)
    || result[guards.length+1]?.meta?.changes !== 1) fail('atomic_batch_not_committed');
  const approval = await db.prepare(`SELECT approval_id,canonical_plan_json,canonical_plan_sha256,approved_operator_staff_id,
    approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,
    issued_by_staff_id,issued_by_access_subject,issued_at,expires_at,revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?`)
    .bind(prepared.approval.approvalId).first();
  const receipt = await db.prepare(`SELECT command_id,approval_id,operator_staff_id,operator_access_subject,canonical_plan_json,
    canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256
    FROM native_staff_bootstrap_receipts WHERE command_id=?`).bind(prepared.commandId).first();
  const control = await db.prepare(`SELECT enabled,generation,applied_generation,lease_id,lease_until,attempt_generation,last_success_at,last_error
    FROM native_staff_access_reconciliation WHERE singleton=1`).first();
  if (!approval || !receipt || approval.approval_id !== prepared.approval.approvalId
    || approval.approved_operator_staff_id !== prepared.approval.operatorStaffId
    || approval.approved_operator_access_subject !== prepared.approval.operatorSubject
    || approval.issued_by_staff_id !== prepared.approval.operatorStaffId
    || approval.issued_by_access_subject !== prepared.approval.operatorSubject
    || approval.issued_at !== prepared.approval.issuedAt || approval.expires_at !== prepared.approval.expiresAt
    || !control || control.enabled !== 1 || control.generation !== 0 || control.applied_generation !== 0
    || control.lease_id !== null || approval.revoked_at !== null || approval.canonical_plan_json !== prepared.canonicalPlanJson
    || approval.canonical_plan_sha256 !== prepared.planSha256 || approval.independent_binding_verification_json !== prepared.bindingEvidenceJson
    || approval.independent_binding_verification_sha256 !== prepared.bindingSha256
    || receipt.command_id !== prepared.commandId || receipt.approval_id !== prepared.approval.approvalId
    || receipt.operator_staff_id !== prepared.approval.operatorStaffId
    || receipt.operator_access_subject !== prepared.approval.operatorSubject
    || receipt.canonical_plan_json !== prepared.canonicalPlanJson || receipt.canonical_plan_sha256 !== prepared.planSha256
    || receipt.independent_binding_verification_json !== prepared.bindingEvidenceJson || receipt.independent_binding_verification_sha256 !== prepared.bindingSha256
    || receipt.result_json !== expectedResultJson(prepared) || receipt.result_sha256 !== sha(expectedResultJson(prepared))) fail('durable_readback_uncertain');
  return Object.freeze({ schemaVersion:1, action:'native-staff-cutover', approvalId:prepared.approval.approvalId,
    commandId:prepared.commandId, cohortSha256:prepared.plan.cohortSha256, enabled:1, generation:0,
    planSha256:prepared.planSha256, snapshotSha256:prepared.reviewedSnapshot.snapshotSha256 });
}
