import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const fail = code => { throw new Error(`native_staff_bootstrap_${code}`); };
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value === null || typeof value !== 'object' ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest = value => sha(canonical(value));
const qid = value => {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) fail('schema_identifier_invalid');
  return `"${value}"`;
};
const sqlText = value => `'${String(value).replaceAll("'","''")}'`;
const REVIEWED_MIGRATION_NAMES_SHA256 = 'e9ca08f7e051a7581da54ba585b740d0cbf033c91f69470649750ae2fdabd8a7';
const REVIEWED_MIGRATION_CONTENTS_SHA256 = '86214ff46aabe9ea1dd1ff94a84eb66ac63d25a1e7ab9c41bf79aef11c476005';
const LEGACY_TABLES = Object.freeze([
  'staff_users','staff_divisions','permissions','roles','role_permissions','staff_role_assignments',
  'staff_permission_overrides','local_staff_role_assignments',
]);
const AUTHORITY_WIDE_TABLES = new Set(['native_business_areas','native_business_divisions','native_staff_authority_capabilities',
  'native_staff_access_reconciliation']);
const INSTALL_COLUMNS = Object.freeze({
  native_business_areas:['id','name','active'],
  native_staff_admissions:['staff_id','bound_access_subject','active','admitted_by'],
  native_staff_profiles:['staff_id','login_email','display_name','version'],
  native_staff_target_memberships:['id','staff_id','scope_kind','business_area_id','division_id','active','version','created_by'],
  native_staff_admin_delegations:['id','actor_staff_id','action','effect','scope_kind','business_area_id','division_id','target_staff_id','active','version','granted_by'],
  native_staff_management_delegations:['id','actor_staff_id','contract_version','authority_domain','capability','effect','scope_kind','business_area_id','division_id','target_staff_id','active','version','granted_by'],
  native_staff_delegation_ceilings:['id','parent_delegation_id','contract_version','authority_domain','capability','effect','grant_allow','grant_deny','operation_create','operation_revoke','scope_kind','business_area_id','division_id','resource_id','target_staff_id'],
  native_directory_grants:['id','staff_id','permission','effect','scope_kind','business_area_id','division_id','resource_id','active','granted_by'],
  native_directory_assignments:['record_id','staff_id','active','assigned_by'],
});
const INSTALL_ORDER=Object.freeze({native_business_areas:0,native_staff_admissions:1,native_staff_profiles:2,
  native_staff_target_memberships:3,native_staff_management_delegations:4,native_staff_admin_delegations:4,
  native_staff_delegation_ceilings:5,native_directory_grants:6,native_directory_assignments:7});
const ROW_KEYS=Object.freeze({native_business_areas:'id',native_staff_admissions:'staff_id',native_staff_profiles:'staff_id',
  native_staff_target_memberships:'id',native_staff_admin_delegations:'id',native_staff_management_delegations:'id',
  native_staff_delegation_ceilings:'id',native_directory_grants:'id',native_directory_assignments:'record_id'});
const ID_COLUMNS = new Set(['staff_id','actor_staff_id','target_staff_id','granted_by','admitted_by','created_by',
  'approved_by_staff_id','operator_staff_id','approved_operator_staff_id','issued_by_staff_id','owner_staff_id',
  'beneficiary_staff_id','selected_by_staff_id','reviewed_by_staff_id','terminal_by_staff_id','created_by_staff_id']);
const MANAGEMENT_BATCH_MAX_STATEMENTS=256;
const MANAGEMENT_BATCH_MAX_BYTES=16*1024*1024;
const COMPILED_PREPARED=new WeakMap();

function deepFreeze(value){
  if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
  for(const child of Object.values(value))deepFreeze(child);
  return Object.freeze(value);
}

function cloneCanonical(value,code){
  try{
    const encoded=canonical(value);
    const cloned=JSON.parse(encoded);
    if(canonical(cloned)!==encoded)fail(code);
    return cloned;
  }catch(error){
    if(String(error?.message||'').includes('native_staff_bootstrap_'))throw error;
    fail(code);
  }
}

/** Build one bounded Cloudflare D1 management API batch body without coercing
 * bind parameters, splitting statements, embedding values in SQL, or retrying. */
export function compileNativeStaffBootstrapManagementBatch(statements){
  if(!Array.isArray(statements)||statements.length<1||statements.length>MANAGEMENT_BATCH_MAX_STATEMENTS)fail('management_batch_size_invalid');
  const batch=statements.map(statement=>{
    if(!statement||typeof statement.sql!=='string'||!statement.sql.length||statement.sql.length>1_000_000
      ||!Array.isArray(statement.params)||statement.params.length>1_000)fail('management_statement_invalid');
    for(const value of statement.params){
      if(value!==null&&typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value)))
        fail('management_parameter_type_unsupported');
    }
    return {sql:statement.sql,params:[...statement.params]};
  });
  const request={batch};
  if(Buffer.byteLength(JSON.stringify(request),'utf8')>MANAGEMENT_BATCH_MAX_BYTES)fail('management_batch_too_large');
  return request;
}

/** Dispatch exactly one compiled batch. The injected transport must perform one
 * API request and return normalized per-statement D1 results; it must not retry. */
export async function submitNativeStaffBootstrapManagementBatch(postBatch,statements){
  if(typeof postBatch!=='function')fail('management_transport_required');
  const request=compileNativeStaffBootstrapManagementBatch(statements);
  return postBatch(request);
}

async function all(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  if (result?.success !== true || !Array.isArray(result.results)) fail('read_failed');
  return result.results;
}

async function schemaModel(db) {
  const schema = await all(db, `SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA')
      AND type IN ('table','view','index','trigger') ORDER BY type,name`);
  const tables = new Map();
  const realTables=schema.filter(row=>row.type==='table'&&row.name!=='d1_migrations');
  const columnRows=await all(db,`SELECT s.name table_name,p.name column_name FROM sqlite_schema s
    JOIN pragma_table_info(s.name) p WHERE s.type='table' AND s.name NOT LIKE 'sqlite_%'
      AND s.name NOT IN ('_cf_KV','_cf_METADATA','d1_migrations') ORDER BY s.name,p.cid`);
  for(const object of realTables)tables.set(object.name,columnRows.filter(row=>row.table_name===object.name).map(row=>row.column_name));
  if (!schema.some(row=>row.type==='table'&&row.name==='d1_migrations')) fail('migration_ledger_missing');
  tables.set('d1_migrations',['name']);
  for (const name of LEGACY_TABLES) if (!tables.has(name)) fail('legacy_schema_missing');
  for (const table of Object.keys(INSTALL_COLUMNS)) {
    if (!tables.has(table) || INSTALL_COLUMNS[table].some(column => !tables.get(table).includes(column))) fail('install_schema_mismatch');
  }
  return { schema, tables };
}

function tableStateSql(table, columns, idsJson) {
  // Authentication refreshes this one telemetry timestamp independently of
  // authority changes. Keep every other staff_users field in the CAS, and keep
  // last_seen_at in the schema fingerprint, but do not stale a reviewed plan
  // merely because a live session was observed.
  const stateColumns=table==='staff_users'?columns.filter(column=>column!=='last_seen_at'):columns;
  const selected = stateColumns.map(column => `${sqlText(column)},${qid(column)}`).join(',');
  let predicate = '';
  if (LEGACY_TABLES.includes(table) || AUTHORITY_WIDE_TABLES.has(table)) predicate = '';
  else {
    const references = columns.filter(column => ID_COLUMNS.has(column)||/(?:staff|user)_id$/u.test(column));
    if (!references.length) return null;
    predicate = ` WHERE ${references.map(column => `${qid(column)} IN (SELECT value FROM selected_ids)`).join(' OR ')}`;
  }
  const from = `SELECT ${stateColumns.map(qid).join(',')} FROM ${qid(table)}${predicate} ORDER BY ${stateColumns.map(qid).join(',')}`;
  return `json((SELECT json_group_array(json_object(${selected})) FROM (${from})))`;
}

function stateObjectSql(model, idsJson, selectedNames = [...model.tables.keys()]) {
  const entries=[];
  for(const name of [...selectedNames].sort()){
    const columns=model.tables.get(name);
    if(!columns)fail('schema_model_incomplete');
    const sql=tableStateSql(name,columns,idsJson);
    if(sql)entries.push(`${JSON.stringify(name)},${sql}`);
  }
  return `json_object(${entries.join(',')})`;
}

function snapshotQuery(model, idsJson) {
  const ledger = `json((SELECT json_group_array(name) FROM (SELECT name FROM d1_migrations ORDER BY name)))`;
  const names=[...model.tables.keys()].filter(name=>name!=='d1_migrations').sort(),queries=[
    {key:'schema_count',sql:`SELECT json_array(count(*)) AS value FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA') AND type IN ('table','view','index','trigger')`,params:[]},
    {key:'ledger',sql:`SELECT ${ledger} AS value`,params:[]},
  ];
  const schemaObjects=model.schema;
  for(let offset=0;offset<schemaObjects.length;offset+=20){
    const chunk=schemaObjects.slice(offset,offset+20),objectNames=JSON.stringify(chunk.map(row=>row.name));
    queries.push({key:`schema:${offset/20}`,sql:`SELECT coalesce(json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)),'[]') AS value
      FROM (SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (SELECT value FROM json_each(?)) ORDER BY type,name)`,params:[objectNames]});
  }
  for(let offset=0;offset<names.length;offset+=20){
    const chunk=names.slice(offset,offset+20),state=stateObjectSql(model,idsJson,chunk);
    queries.push({key:`rows:${offset/20}`,sql:`WITH selected_ids(value) AS (SELECT value FROM json_each(?)) SELECT ${state} AS value`,params:[idsJson]});
  }
  return queries;
}

function parseSnapshotParts(queries,results){
  const values=new Map();
  for(let i=0;i<queries.length;i++)values.set(queries[i].key,JSON.parse(results[i].results[0].value));
  const rows={};for(let index=0;values.has(`rows:${index}`);index++)Object.assign(rows,values.get(`rows:${index}`));
  const schema=[];for(let index=0;values.has(`schema:${index}`);index++)schema.push(...values.get(`schema:${index}`));
  return {schema_count:values.get('schema_count')?.[0],schema,ledger:values.get('ledger'),rows};
}

function verifySourceMigrationChain(names) {
  const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../apps/operations/migrations');
  const local=readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/u.test(name)&&Number(name.slice(0,4))<=225).sort();
  if (local.length!==225||local.at(-1)!=='0225_native_staff_lifecycle_bridge.sql'
    ||sha(local.join('\n'))!==REVIEWED_MIGRATION_NAMES_SHA256) fail('source_migration_chain_changed');
  const contentDigest=sha(local.map(name=>{
    const file=path.join(directory,name),stat=lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()) fail('source_migration_file_invalid');
    return `${name}\0${sha(readFileSync(file))}`;
  }).join('\n'));
  if(contentDigest!==REVIEWED_MIGRATION_CONTENTS_SHA256||canonical(local)!==canonical(names)) fail('migration_chain_mismatch');
}

function staffRows(snapshot) { return JSON.parse(snapshot).rows.staff_users; }
function migrationNames(snapshot) { return JSON.parse(snapshot).ledger; }
function verifyPlanRows(plan, snapshot) {
  if (!own(plan,['kind','reviewedSnapshotSha256','approvalId','staffCohort','controlPlaneStaffIds','rows'])
    || plan.kind !== 'operations-native-staff-bootstrap-install-v1' || !Array.isArray(plan.rows)
    || !Array.isArray(plan.staffCohort) || !Array.isArray(plan.controlPlaneStaffIds)) fail('plan_invalid');
  const users = staffRows(snapshot), byId = new Map(users.map(row => [row.id,row]));
  const admissions = plan.rows.filter(row => row?.table === 'native_staff_admissions');
  const profiles = plan.rows.filter(row => row?.table === 'native_staff_profiles');
  const ids = admissions.map(row => row.row?.staff_id);
  if (!ids.length || new Set(ids).size !== ids.length || profiles.length !== ids.length
    || ids.some(id => !plan.staffCohort.includes(id)) || plan.staffCohort.length !== ids.length
    || new Set(plan.staffCohort).size !== plan.staffCohort.length) fail('plan_cohort_invalid');
  for (const admission of admissions) {
    const id = admission.row.staff_id, user = byId.get(id), profile = profiles.find(row => row.row.staff_id === id)?.row;
    if (!user || user.status !== 'active' || !user.access_subject || admission.row.active !== 1
      || admission.row.bound_access_subject !== user.access_subject || !profile || profile.login_email !== user.email
      || profile.display_name !== user.display_name || profile.version !== 1) fail('identity_binding_mismatch');
  }
  if (!plan.controlPlaneStaffIds.length || new Set(plan.controlPlaneStaffIds).size !== plan.controlPlaneStaffIds.length
    || plan.controlPlaneStaffIds.some(id => !byId.get(id) || byId.get(id).status!=='active')) fail('plan_control_plane_invalid');
  const counts = new Map();
  for (const operation of plan.rows) {
    if (!own(operation,['table','row']) || !Object.hasOwn(INSTALL_COLUMNS,operation.table)) fail('plan_table_invalid');
    const columns = INSTALL_COLUMNS[operation.table];
    if (!own(operation.row,columns)) fail('plan_row_invalid');
    counts.set(operation.table,(counts.get(operation.table) ?? 0)+1);
  }
  if(plan.rows.some((item,index)=>index>0&&INSTALL_ORDER[plan.rows[index-1].table]>INSTALL_ORDER[item.table]))fail('plan_row_order_invalid');
  if (counts.get('native_staff_admissions') !== ids.length || counts.get('native_staff_profiles') !== ids.length) fail('plan_identity_rows_invalid');
}

const TRUST_ENVELOPE_KEYS=Object.freeze(['schemaVersion','action','ownerSessionId','authorizationChallenge','approvalId','commandId',
  'approvedOperatorStaffId','approvedOperatorAccessSubject','issuedByStaffId','issuedByAccessSubject','authorizedAt','expiresAt',
  'reviewedSnapshotSha256','canonicalPlanSha256','bindingEvidenceSha256','consentPhrase']);
function verifyEnvelopeClaims(envelope,input,planSha256,bindingSha256,snapshotSha256){
  if(!own(envelope,TRUST_ENVELOPE_KEYS)||envelope.schemaVersion!==1||envelope.action!=='install-operations-native-staff-bootstrap'
    ||typeof envelope.ownerSessionId!=='string'||!envelope.ownerSessionId.trim()
    ||typeof envelope.authorizationChallenge!=='string'||!envelope.authorizationChallenge.trim()
    ||envelope.approvalId!==input.approval.approvalId||envelope.commandId!==input.commandId
    ||envelope.approvedOperatorStaffId!==input.approval.approvedOperatorStaffId
    ||envelope.approvedOperatorAccessSubject!==input.approval.approvedOperatorAccessSubject
    ||envelope.issuedByStaffId!==input.approval.issuedByStaffId||envelope.issuedByAccessSubject!==input.approval.issuedByAccessSubject
    ||envelope.authorizedAt!==input.approval.issuedAt||envelope.expiresAt!==input.approval.expiresAt
    ||envelope.reviewedSnapshotSha256!==snapshotSha256||envelope.canonicalPlanSha256!==planSha256
    ||envelope.bindingEvidenceSha256!==bindingSha256
    ||envelope.consentPhrase!=='I approve this exact Operations staff cohort and native authority plan')fail('trust_envelope_invalid');
}

/** Read exact schema, full Ops legacy access rows, complete cohort, control-plane
 * candidates and every native row joined to the existing or proposed cohort. */
export async function readNativeStaffBootstrapSnapshot(db, proposedStaffIds = []) {
  if (!db || typeof db.prepare !== 'function' || !Array.isArray(proposedStaffIds)) fail('database_invalid');
  const model = await schemaModel(db);
  const users = await all(db,'SELECT id FROM staff_users ORDER BY id');
  const ids = [...new Set([...users.map(row => row.id),...proposedStaffIds])].sort();
  if (!ids.length || ids.some(id => typeof id !== 'string' || !id.length || id.length > 191)) fail('cohort_invalid');
  const queries=snapshotQuery(model,JSON.stringify(ids));
  const results=await db.batch(queries.map(query=>db.prepare(query.sql).bind(...query.params)));
  if(!Array.isArray(results)||results.length!==queries.length||results.some(result=>result?.success!==true||!Array.isArray(result.results)||typeof result.results[0]?.value!=='string'))fail('snapshot_invalid');
  const result=JSON.stringify(parseSnapshotParts(queries,results));
  if(Buffer.byteLength(result)>16*1024*1024)fail('snapshot_invalid');
  const migrations = migrationNames(result);
  if (!Array.isArray(migrations) || migrations.length !== 225 || migrations.at(-1) !== '0225_native_staff_lifecycle_bridge.sql'
    || migrations.some((name,index) => !new RegExp(`^${String(index+1).padStart(4,'0')}_.*\\.sql$`,'u').test(name))) fail('migration_chain_mismatch');
  verifySourceMigrationChain(migrations);
  const controlPlaneStaffIds=(await all(db,"SELECT staff_id FROM native_staff_lifecycle_control_plane_candidates ORDER BY staff_id")).map(row=>row.staff_id);
  return Object.freeze({ snapshotJson:result, snapshotSha256:sha(result), migrationNames:Object.freeze(migrations),
    migrationNamesSha256:sha(migrations.join('\n')), currentStaffCount:staffRows(result).length,
    controlPlaneStaffIds:Object.freeze(controlPlaneStaffIds) });
}

function snapshotGuardStatements(model, reviewedSnapshot, idsJson, {failClosed=true}={}){
  const queries=snapshotQuery(model,idsJson),expected=JSON.parse(reviewedSnapshot.snapshotJson),guards=[];
  for(const query of queries){
    if(query.key.startsWith('schema:')){
      const offset=Number(query.key.slice('schema:'.length))*20,expectedChunk=expected.schema.slice(offset,offset+20);
      const predicate=`(SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA')
        AND type IN ('table','view','index','trigger'))=? AND NOT EXISTS(SELECT 1 FROM json_each(?) expected
        WHERE NOT EXISTS(SELECT 1 FROM sqlite_schema current WHERE current.type=json_extract(expected.value,'$.type')
          AND current.name=json_extract(expected.value,'$.name') AND current.tbl_name IS json_extract(expected.value,'$.tbl_name')
          AND current.sql IS json_extract(expected.value,'$.sql')))`;
      guards.push({key:query.key,sql:`SELECT CASE WHEN ${predicate} THEN 1 ELSE ${failClosed?"json('native-staff-bootstrap-snapshot-mismatch')":"0"} END AS verified`,
        params:[expected.schema_count,JSON.stringify(expectedChunk)]});
      continue;
    }
    const inner=query.sql.replace(/ AS value$/u,'');
    let expectedValue;
    if(query.key==='schema_count')expectedValue=[expected.schema_count];
    else if(query.key==='ledger')expectedValue=expected.ledger;
    else{
      const offset=Number(query.key.slice('rows:'.length))*20;
      const names=[...model.tables.keys()].filter(name=>name!=='d1_migrations').sort().slice(offset,offset+20);
      expectedValue=Object.fromEntries(names.filter(name=>Object.hasOwn(expected.rows,name)).map(name=>[name,expected.rows[name]]));
    }
    guards.push({key:query.key,sql:`SELECT CASE WHEN (${inner})=? THEN 1 ELSE ${failClosed?"json('native-staff-bootstrap-snapshot-mismatch')":"0"} END AS verified`,
      params:[...query.params,JSON.stringify(expectedValue)]});
  }
  return guards;
}

function approvalStatement(input) {
  // The schema/ledger/full-state SELECT guards run before this first write,
  // inside the same D1 batch transaction. Invalid state or reused IDs map to
  // NULL so 0060's NOT NULL constraint aborts and rolls the entire batch back.
  const gate = `CASE WHEN julianday(?)<=julianday('now') AND julianday(?)>julianday('now')
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=?)
    AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=? OR approval_id=?)
    THEN ? ELSE NULL END`;
  return { sql:`INSERT INTO native_staff_bootstrap_approvals(approval_id,canonical_plan_json,canonical_plan_sha256,
    approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,
    issued_by_staff_id,issued_by_access_subject,issued_at,expires_at,revoked_at)
    SELECT ${gate},?,?,?,?,?,?,?,?,?,?,NULL`,
    params:[input.approval.issuedAt,input.approval.expiresAt,input.approval.approvalId,
      input.commandId,input.approval.approvalId,input.approval.approvalId,
      input.canonicalPlanJson,input.planSha256,input.approval.approvedOperatorStaffId,input.approval.approvedOperatorAccessSubject,
      input.bindingEvidenceJson,input.bindingSha256,input.approval.issuedByStaffId,input.approval.issuedByAccessSubject,
      input.approval.issuedAt,input.approval.expiresAt] };
}

function gatedInsert(item, approvalId) {
  const columns = INSTALL_COLUMNS[item.table];
  const names = columns.map(qid).join(',');
  const values = columns.map(() => '?').join(',');
  return { sql:`INSERT INTO ${qid(item.table)}(${names}) SELECT ${values}
    WHERE EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=? AND revoked_at IS NULL)`,
    params:[...columns.map(name=>item.row[name]),approvalId] };
}

function receiptSummary(input){
  const result = { schemaVersion:1, approvalId:input.approval.approvalId, commandId:input.commandId,
    canonicalPlanSha256:input.planSha256,bindingEvidenceSha256:input.bindingSha256,
    installedStaffCount:input.plan.staffCohort.length,insertedRowCount:input.plan.rows.length };
  const resultJson = canonical(result);
  return {resultJson,resultSha256:sha(resultJson)};
}

function receiptStatement(input) {
  const {resultJson,resultSha256}=receiptSummary(input);
  const model=input.schemaModel;
  const legacyState=stateObjectSql(model,'null',LEGACY_TABLES);
  const parsed=JSON.parse(input.reviewedSnapshot.snapshotJson).rows;
  const expectedLegacy=JSON.stringify(Object.fromEntries([...LEGACY_TABLES].sort().map(name=>[name,parsed[name]])));
  const expectedControlPlane=JSON.stringify([...input.plan.controlPlaneStaffIds].sort());
  const controlPlane=`coalesce((SELECT json_group_array(staff_id) FROM
    (SELECT staff_id FROM native_staff_lifecycle_control_plane_candidates ORDER BY staff_id)),'[]')`;
  return { sql:`INSERT INTO native_staff_bootstrap_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,
    canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256)
    SELECT CASE WHEN (${legacyState})=? AND ${controlPlane}=?
      AND EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=? AND revoked_at IS NULL)
      THEN ? ELSE NULL END,?,?,?,?,?,?,?,?,?`,
    params:[expectedLegacy,expectedControlPlane,input.approval.approvalId,input.commandId,input.approval.approvalId,
      input.approval.approvedOperatorStaffId,input.approval.approvedOperatorAccessSubject,input.canonicalPlanJson,input.planSha256,
      input.bindingEvidenceJson,input.bindingSha256,resultJson,resultSha256] };
}

async function confirmDurableInstall(db,prepared){
  const approval=await db.prepare(`SELECT approval_id,canonical_plan_json,canonical_plan_sha256,approved_operator_staff_id,
    approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,
    issued_by_staff_id,issued_by_access_subject,issued_at,expires_at,revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?`)
    .bind(prepared.approval.approvalId).first();
  const expectedApproval={approval_id:prepared.approval.approvalId,canonical_plan_json:prepared.canonicalPlanJson,canonical_plan_sha256:prepared.planSha256,
    approved_operator_staff_id:prepared.approval.approvedOperatorStaffId,approved_operator_access_subject:prepared.approval.approvedOperatorAccessSubject,
    independent_binding_verification_json:prepared.bindingEvidenceJson,independent_binding_verification_sha256:prepared.bindingSha256,
    issued_by_staff_id:prepared.approval.issuedByStaffId,issued_by_access_subject:prepared.approval.issuedByAccessSubject,
    issued_at:prepared.approval.issuedAt,expires_at:prepared.approval.expiresAt,revoked_at:null};
  if(!approval||canonical({...approval})!==canonical(expectedApproval))return false;
  const receipt=await db.prepare(`SELECT command_id,approval_id,operator_staff_id,operator_access_subject,canonical_plan_json,canonical_plan_sha256,
    independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256 FROM native_staff_bootstrap_receipts WHERE command_id=?`)
    .bind(prepared.commandId).first();
  const expectedResult=receiptSummary(prepared);
  if(!receipt||receipt.approval_id!==prepared.approval.approvalId||receipt.operator_staff_id!==prepared.approval.approvedOperatorStaffId
    ||receipt.operator_access_subject!==prepared.approval.approvedOperatorAccessSubject||receipt.canonical_plan_json!==prepared.canonicalPlanJson
    ||receipt.canonical_plan_sha256!==prepared.planSha256||receipt.independent_binding_verification_json!==prepared.bindingEvidenceJson
    ||receipt.independent_binding_verification_sha256!==prepared.bindingSha256||receipt.result_json!==expectedResult.resultJson
    ||receipt.result_sha256!==expectedResult.resultSha256||sha(receipt.result_json)!==receipt.result_sha256)return false;
  for(const item of prepared.plan.rows){
    const columns=INSTALL_COLUMNS[item.table],key=ROW_KEYS[item.table];
    const row=await db.prepare(`SELECT ${columns.map(qid).join(',')} FROM ${qid(item.table)} WHERE ${qid(key)}=?`).bind(item.row[key]).first();
    if(!row||canonical({...row})!==canonical(item.row))return false;
  }
  return true;
}

/** Compile an already owner-reviewed canonical plan; never creates trust material. */
export async function prepareNativeStaffBootstrapD1(input, { verifyTrust } = {}) {
  if (typeof verifyTrust !== 'function') fail('trust_verifier_required');
  if (!own(input,['approval','canonicalPlanJson','bindingEvidenceJson','reviewedSnapshot','commandId','trustEnvelope'])
    || !own(input.approval,['approvalId','approvedOperatorStaffId','approvedOperatorAccessSubject','issuedByStaffId','issuedByAccessSubject','issuedAt','expiresAt'])
    || typeof input.canonicalPlanJson !== 'string' || typeof input.bindingEvidenceJson !== 'string'
    || typeof input.reviewedSnapshot?.snapshotJson !== 'string' || typeof input.commandId !== 'string') fail('input_invalid');
  input=deepFreeze(cloneCanonical(input,'input_invalid'));
  let plan; try { plan=JSON.parse(input.canonicalPlanJson); } catch { fail('plan_json_invalid'); }
  let binding;try{binding=JSON.parse(input.bindingEvidenceJson);}catch{fail('artifact_json_invalid');}
  if (canonical(plan)!==input.canonicalPlanJson || canonical(binding)!==input.bindingEvidenceJson) fail('artifact_invalid');
  const planSha256=sha(input.canonicalPlanJson), bindingSha256=sha(input.bindingEvidenceJson);
  verifyEnvelopeClaims(input.trustEnvelope,input,planSha256,bindingSha256,input.reviewedSnapshot.snapshotSha256);
  if (!/^[0-9a-f]{64}$/u.test(input.reviewedSnapshot.snapshotSha256 ?? '')
    || input.reviewedSnapshot.snapshotSha256!==sha(input.reviewedSnapshot.snapshotJson)
    || !await verifyTrust({trustEnvelope:input.trustEnvelope,approval:input.approval,canonicalPlanJson:input.canonicalPlanJson,
      planSha256,bindingEvidenceJson:input.bindingEvidenceJson,bindingSha256,reviewedSnapshot:input.reviewedSnapshot})) fail('independent_approval_missing');
  verifyPlanRows(plan,input.reviewedSnapshot.snapshotJson);
  if (plan.reviewedSnapshotSha256!==input.reviewedSnapshot.snapshotSha256 || plan.approvalId!==input.approval.approvalId) fail('review_binding_invalid');
  if(!plan.controlPlaneStaffIds.includes(input.approval.approvedOperatorStaffId))fail('approved_operator_not_control_plane');
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u.test(input.commandId)) fail('command_id_invalid');
  const prepared=deepFreeze({...input,plan,planSha256,bindingSha256});
  COMPILED_PREPARED.set(prepared,prepared);
  return prepared;
}

/** Execute a compiled install in one D1 atomic batch, with a failing first CAS. */
export async function executeNativeStaffBootstrapD1(db, prepared, { verifyTrust, submitManagementBatch } = {}) {
  if (!db || typeof db.batch!=='function' || typeof verifyTrust!=='function' || !prepared
    || (submitManagementBatch!==undefined&&typeof submitManagementBatch!=='function')) fail('d1_management_required');
  const compiled=COMPILED_PREPARED.get(prepared);
  if(!compiled)fail('prepared_artifact_invalid');
  let plan;try{plan=JSON.parse(compiled.canonicalPlanJson);}catch{fail('plan_json_invalid');}
  if(canonical(plan)!==compiled.canonicalPlanJson||sha(compiled.canonicalPlanJson)!==compiled.planSha256
    ||canonical(plan)!==canonical(compiled.plan))fail('prepared_plan_integrity_mismatch');
  const binding=cloneCanonical(JSON.parse(compiled.bindingEvidenceJson),'artifact_invalid');
  if(canonical(binding)!==compiled.bindingEvidenceJson||sha(compiled.bindingEvidenceJson)!==compiled.bindingSha256)fail('prepared_binding_integrity_mismatch');
  const snapshotSha=sha(compiled.reviewedSnapshot.snapshotJson);
  if(snapshotSha!==compiled.reviewedSnapshot.snapshotSha256||!Array.isArray(compiled.reviewedSnapshot.controlPlaneStaffIds))
    fail('prepared_snapshot_integrity_mismatch');
  verifyEnvelopeClaims(compiled.trustEnvelope,compiled,compiled.planSha256,compiled.bindingSha256,snapshotSha);
  verifyPlanRows(plan,compiled.reviewedSnapshot.snapshotJson);
  if(plan.reviewedSnapshotSha256!==snapshotSha||plan.approvalId!==compiled.approval.approvalId
    ||!plan.controlPlaneStaffIds.includes(compiled.approval.approvedOperatorStaffId))fail('review_binding_invalid');
  const execution=deepFreeze({...compiled,plan});
  if (!await verifyTrust({trustEnvelope:execution.trustEnvelope,approval:execution.approval,canonicalPlanJson:execution.canonicalPlanJson,
    planSha256:execution.planSha256,bindingEvidenceJson:execution.bindingEvidenceJson,bindingSha256:execution.bindingSha256,
    reviewedSnapshot:execution.reviewedSnapshot})) fail('independent_approval_revoked');
  const model=await schemaModel(db), ids=JSON.parse(execution.reviewedSnapshot.snapshotJson).rows.staff_users.map(row=>row.id);
  const proposed=execution.plan.staffCohort;
  const stateIds=[...new Set([...ids,...proposed])].sort();
  const probe=snapshotGuardStatements(model,execution.reviewedSnapshot,JSON.stringify(stateIds),{failClosed:false});
  let probeResults;
  try{probeResults=await db.batch(probe.map(statement=>db.prepare(statement.sql).bind(...statement.params)));}
  catch{fail('snapshot_recheck_failed');}
  if(!Array.isArray(probeResults)||probeResults.length!==probe.length||probeResults.some((row,index)=>row?.success!==true||row.results?.[0]?.verified!==1)){
    const mismatch=Array.isArray(probeResults)?probeResults.findIndex(row=>row?.results?.[0]?.verified!==1):-1;
    fail(`snapshot_changed${mismatch>=0?`_${probe[mismatch].key}`:''}`);
  }
  const guards=snapshotGuardStatements(model,execution.reviewedSnapshot,JSON.stringify(stateIds));
  const batch=[...guards,
    approvalStatement(execution),...execution.plan.rows.map(item=>gatedInsert(item,execution.approval.approvalId)),
    receiptStatement({...execution,schemaModel:model})];
  if (!await verifyTrust({trustEnvelope:execution.trustEnvelope,approval:execution.approval,canonicalPlanJson:execution.canonicalPlanJson,
    planSha256:execution.planSha256,bindingEvidenceJson:execution.bindingEvidenceJson,bindingSha256:execution.bindingSha256,
    reviewedSnapshot:execution.reviewedSnapshot})) fail('independent_approval_revoked');
  let result;
  try {
    result=submitManagementBatch
      ? await submitNativeStaffBootstrapManagementBatch(submitManagementBatch,batch)
      : await db.batch(batch.map(statement=>db.prepare(statement.sql).bind(...statement.params)));
  }
  catch(error) { throw new Error('native_staff_bootstrap_atomic_batch_refused',{cause:error}); }
  if (!Array.isArray(result)||result.length!==batch.length||result.some(row=>row?.success!==true)
    ||result.slice(0,guards.length).some(row=>row.results?.[0]?.verified!==1)) fail('atomic_batch_not_committed');
  if(!await confirmDurableInstall(db,execution))fail('commit_outcome_uncertain');
  return Object.freeze({schemaVersion:1,approvalId:execution.approval.approvalId,commandId:execution.commandId,
    canonicalPlanSha256:execution.planSha256,bindingEvidenceSha256:execution.bindingSha256,
    insertedRowCount:execution.plan.rows.length+2,staffCount:execution.plan.staffCohort.length});
}

export const nativeStaffBootstrapD1InsertColumns = INSTALL_COLUMNS;
