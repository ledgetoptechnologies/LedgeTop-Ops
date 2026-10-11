import type { AuthenticatedNativeStaffWithAdmissionVersion as Actor } from './native-staff-auth';

/** Private, review-only data. A plan/hash is neither approval nor authentication. */
export type NativeDirectoryMaintenanceTarget = Readonly<{
  environment: 'staging'; accountLabel: string; workerLabel: string; databaseLabel: string;
}>;
/** Nonsecret exact staging identity. A trusted runner MUST independently verify
 * the provider Worker's ENVIRONMENT and OPS_DB binding before calling; a D1
 * JavaScript object has no API that proves its physical provider identity. */
export const NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET:NativeDirectoryMaintenanceTarget=Object.freeze({
  environment:'staging',accountLabel:'846c924bf17bf4f3dd15c97a4c5d1d51',workerLabel:'ledgetop-ops-staging',databaseLabel:'78b34173-b168-4e3d-9832-bb9d245cc6b8',
});
export type NativeDirectoryMaintenanceIdentityEvidence = Readonly<{
  staffId: string; accessSubject: string; verificationId: string;
  verifiedAt: string; expiresAt: string; issuer: string;
}>;
export type NativeDirectoryMaintenancePlanInput = Readonly<{
  target: NativeDirectoryMaintenanceTarget; staffId: string; grantId: string; commandId:string;
  operator: Readonly<{staffId: string; accessSubject: string}>;
  approvalIssuer: Readonly<{staffId:string;accessSubject:string}>;
  identityEvidence: NativeDirectoryMaintenanceIdentityEvidence;
}>;
type Scalar = string | number | null;
type Row = Readonly<Record<string, Scalar>>;
const tables = {
  staff: {name:'staff_users', key:'id', columns:'id,email,display_name,access_subject,project_alpha_user_id,status,created_at,updated_at,last_seen_at,provisioning_source,sync_protected', limit:1},
  admission: {name:'native_staff_admissions',key:'staff_id',columns:'staff_id,bound_access_subject,active,admitted_by,created_at,updated_at,version',limit:1},
  profile: {name:'native_staff_profiles',key:'staff_id',columns:'staff_id,login_email,display_name,version,created_at,updated_at',limit:1},
  roles: {name:'staff_role_assignments',key:'staff_id',columns:'id,staff_id,role_id,scope,division_id,scope_key,created_by,created_at',limit:64},
  grants: {name:'native_directory_grants',key:'staff_id',columns:'id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,granted_by,created_at',limit:128},
  history: {name:'native_directory_grant_history',key:'staff_id',columns:'grant_id,grant_version,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,grant_generation,recorded_at',limit:512},
  generation: {name:'native_directory_grant_generations',key:'staff_id',columns:'staff_id,generation,updated_at',limit:1},
} as const;
type Snapshot = Readonly<Record<keyof typeof tables, readonly Row[]>>;
export type NativeDirectoryMaintenanceAuthorityPlan = NativeDirectoryMaintenancePlanInput & Readonly<{
  protocol: 'native-directory-maintenance-authority'; version: 1; snapshot: Snapshot;
}>;
export type CompiledNativeDirectoryMaintenanceAuthorityPlan = Readonly<{
  plan: NativeDirectoryMaintenanceAuthorityPlan; canonicalPlanJson: string; canonicalPlanSha256: string;
  independentBindingVerificationJson:string; independentBindingVerificationSha256:string;
}>;
export type NativeDirectoryMaintenanceAuthorityResult = Readonly<{
  status:'applied'|'replayed'; commandId:string; approvalId:string; grantId:string; resultingGeneration:number;
}>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:/|-]{0,190}$/u;
const fail=():never=>{throw new Error('native_directory_maintenance_authority_denied');};
const valid=(v:unknown):v is string=>typeof v==='string'&&ID.test(v);
function exact(v:unknown,keys:readonly string[]):v is Record<string,unknown>{
  return !!v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype
    && Reflect.ownKeys(v).length===keys.length&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&keys.includes(k)
      && Object.getOwnPropertyDescriptor(v,k)?.enumerable===true&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)!,'value'));
}
function canonical(v:unknown):string{
  if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isSafeInteger(v))return JSON.stringify(v);
  if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  if(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype)return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(Reflect.get(v,k))}`).join(',')}}`;
  return fail();
}
async function sha(value:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function inputValid(input:NativeDirectoryMaintenancePlanInput){
  if(!exact(input,['target','staffId','grantId','commandId','operator','approvalIssuer','identityEvidence'])||!valid(input.staffId)||!valid(input.grantId)||!valid(input.commandId)
    ||!exact(input.target,['environment','accountLabel','workerLabel','databaseLabel'])||input.target.environment!=='staging'
    ||canonical(input.target)!==canonical(NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET)
    ||!exact(input.operator,['staffId','accessSubject'])||input.operator.staffId!==input.staffId||!valid(input.operator.accessSubject)
    ||!exact(input.approvalIssuer,['staffId','accessSubject'])||!valid(input.approvalIssuer.staffId)||!valid(input.approvalIssuer.accessSubject)
    ||!exact(input.identityEvidence,['staffId','accessSubject','verificationId','verifiedAt','expiresAt','issuer']))fail();
  const e=input.identityEvidence;
  if(e.staffId!==input.staffId||e.accessSubject!==input.operator.accessSubject||!valid(e.verificationId)||!valid(e.issuer)
    ||![e.verifiedAt,e.expiresAt].every(t=>typeof t==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(t)&&Number.isFinite(Date.parse(t))&&new Date(t).toISOString()===t)
    ||Date.parse(e.expiresAt)<=Date.parse(e.verifiedAt)||Date.parse(e.expiresAt)-Date.parse(e.verifiedAt)>86_400_000)fail();
}
function validatePlan(plan:NativeDirectoryMaintenanceAuthorityPlan){
  if(!exact(plan,['protocol','version','target','staffId','grantId','commandId','operator','approvalIssuer','identityEvidence','snapshot'])
    ||plan.protocol!=='native-directory-maintenance-authority'||plan.version!==1)fail();
  inputValid({target:plan.target,staffId:plan.staffId,grantId:plan.grantId,commandId:plan.commandId,operator:plan.operator,approvalIssuer:plan.approvalIssuer,identityEvidence:plan.identityEvidence});
  if(!exact(plan.snapshot,Object.keys(tables)))fail();
  for(const name of Object.keys(tables) as (keyof typeof tables)[]){
    const spec=tables[name],rows=plan.snapshot[name];if(!Array.isArray(rows)||rows.length>spec.limit)fail();
    for(const row of rows)if(!exact(row,spec.columns.split(','))||Object.values(row).some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isSafeInteger(v))))fail();
    if(new Set(rows.map(canonical)).size!==rows.length)fail();
  }
  const s=plan.snapshot;
  if(s.staff.length!==1||s.admission.length!==1||s.profile.length!==1||s.generation.length>1
    ||s.staff[0]!.id!==plan.staffId||s.staff[0]!.status!=='active'||s.staff[0]!.access_subject!==plan.operator.accessSubject
    ||s.admission[0]!.staff_id!==plan.staffId||s.admission[0]!.active!==1||s.admission[0]!.bound_access_subject!==plan.operator.accessSubject
    ||s.profile[0]!.staff_id!==plan.staffId||!s.roles.some(r=>r.role_id==='role-owner'&&r.scope==='global')
    ||s.grants.some(r=>r.id===plan.grantId||r.permission==='directory.portal_access.manage'&&(r.effect==='deny'&&r.active===1||r.effect==='allow'&&r.scope_kind==='global'))
    ||s.grants.some(r=>r.staff_id!==plan.staffId)||s.history.some(r=>r.staff_id!==plan.staffId)||s.roles.some(r=>r.staff_id!==plan.staffId)
    ||s.generation.some(r=>r.staff_id!==plan.staffId||typeof r.generation!=='number'||r.generation<1||r.generation>=Number.MAX_SAFE_INTEGER))fail();
  const generation=Number(s.generation[0]?.generation??0),ids=new Set(s.grants.map(g=>g.id));
  if(s.grants.length>0&&s.generation.length!==1||s.history.some(h=>!ids.has(h.grant_id)
    ||typeof h.grant_version!=='number'||h.grant_version<1||typeof h.grant_generation!=='number'
    ||h.grant_generation<1||h.grant_generation>generation))fail();
  const identity=['staff_id','permission','effect','scope_kind','business_area_id','division_id','resource_id'] as const;
  for(const grant of s.grants){
    const history=s.history.filter(h=>h.grant_id===grant.id).sort((a,b)=>Number(a.grant_version)-Number(b.grant_version));
    if(!history.length||history.some((h,i)=>h.grant_version!==i+1||identity.some(k=>h[k]!==grant[k])
      ||i>0&&Number(h.grant_generation)<=Number(history[i-1]!.grant_generation))
      ||history.at(-1)!.active!==grant.active)fail();
  }
  if(s.history.length&&Math.max(...s.history.map(h=>Number(h.grant_generation)))!==generation
    ||!s.grants.length&&(s.history.length>0||s.generation.length>0))fail();
  if(new TextEncoder().encode(canonical(plan)).byteLength>131072)fail();
}
/** Read-only bounded compiler. Trusted caller must independently verify the
 * physical binding matches the exact pinned staging IDs; supplied IDs alone
 * prove neither provider identity nor authorization. */
export async function compileNativeDirectoryMaintenanceAuthorityPlan(db:D1Database,input:NativeDirectoryMaintenancePlanInput):Promise<CompiledNativeDirectoryMaintenanceAuthorityPlan>{
  inputValid(input);const session=db.withSession('first-primary');
  const entries=await Promise.all((Object.keys(tables) as (keyof typeof tables)[]).map(async name=>{
    const spec=tables[name],rows=(await session.prepare(`SELECT ${spec.columns} FROM ${spec.name} WHERE ${spec.key}=? LIMIT ${spec.limit+1}`).bind(input.staffId).all<Row>()).results;
    return [name,rows.sort((a,b)=>canonical(a).localeCompare(canonical(b)))] as const;
  }));
  const rows=(name:keyof typeof tables)=>entries.find(entry=>entry[0]===name)?.[1]??fail();
  const snapshot:Snapshot={staff:rows('staff'),admission:rows('admission'),profile:rows('profile'),roles:rows('roles'),
    grants:rows('grants'),history:rows('history'),generation:rows('generation')};
  const plan:NativeDirectoryMaintenanceAuthorityPlan={...input,protocol:'native-directory-maintenance-authority',version:1,snapshot};
  validatePlan(plan);const canonicalPlanJson=canonical(plan),independentBindingVerificationJson=canonical(plan.identityEvidence);
  return {plan,canonicalPlanJson,canonicalPlanSha256:await sha(canonicalPlanJson),independentBindingVerificationJson,
    independentBindingVerificationSha256:await sha(independentBindingVerificationJson)};
}
export type FrozenNativeDirectoryMaintenanceApproval = Readonly<{
  approvalId:string; plan:NativeDirectoryMaintenanceAuthorityPlan; canonicalPlanSha256:string;
}>;
/** Loads only the immutable plan already approved out-of-band. This validates
 * canonical bytes without recomputing today's snapshot: executor's receipt
 * path must remain usable after an uncertain successful first execution. */
export async function readFrozenNativeDirectoryMaintenanceApproval(db:D1Database,approvalId:string,
  commandId:string,canonicalPlanSha256:string):Promise<FrozenNativeDirectoryMaintenanceApproval>{
  if(!valid(approvalId)||!valid(commandId)||!/^[0-9a-f]{64}$/u.test(canonicalPlanSha256))fail();
  const raw:unknown=await db.prepare(`SELECT approval_id,canonical_plan_json,canonical_plan_sha256,
    approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,
    independent_binding_verification_sha256,issued_by_staff_id,issued_by_access_subject
    FROM native_directory_maintenance_authority_approvals WHERE approval_id=?`).bind(approvalId).first<unknown>();
  const columns=['approval_id','canonical_plan_json','canonical_plan_sha256','approved_operator_staff_id',
    'approved_operator_access_subject','independent_binding_verification_json','independent_binding_verification_sha256',
    'issued_by_staff_id','issued_by_access_subject'] as const;
  if(!exact(raw,columns))throw Error('native_directory_maintenance_authority_denied');
  const jsonValue=raw.canonical_plan_json;
  if(typeof jsonValue!=='string')throw Error('native_directory_maintenance_authority_denied');
  const json=jsonValue;
  if(new TextEncoder().encode(json).byteLength>131072||raw.approval_id!==approvalId
    ||raw.canonical_plan_sha256!==canonicalPlanSha256)fail();
  let value:unknown;try{value=JSON.parse(json) as unknown;}catch{return fail();}
  const keys=['protocol','version','target','staffId','grantId','commandId','operator','approvalIssuer','identityEvidence','snapshot'] as const;
  if(!exact(value,keys))throw Error('native_directory_maintenance_authority_denied');
  if(value.protocol!=='native-directory-maintenance-authority'||value.version!==1||value.commandId!==commandId
    ||typeof value.staffId!=='string'||typeof value.grantId!=='string')throw Error('native_directory_maintenance_authority_denied');
  const target=value.target,operator=value.operator,approvalIssuer=value.approvalIssuer,evidence=value.identityEvidence,snapshotValue=value.snapshot;
  if(!exact(target,['environment','accountLabel','workerLabel','databaseLabel'])||target.environment!=='staging'
    ||typeof target.accountLabel!=='string'||typeof target.workerLabel!=='string'||typeof target.databaseLabel!=='string')throw Error('native_directory_maintenance_authority_denied');
  if(!exact(operator,['staffId','accessSubject'])||typeof operator.staffId!=='string'||typeof operator.accessSubject!=='string')throw Error('native_directory_maintenance_authority_denied');
  if(!exact(approvalIssuer,['staffId','accessSubject'])||typeof approvalIssuer.staffId!=='string'
    ||typeof approvalIssuer.accessSubject!=='string')throw Error('native_directory_maintenance_authority_denied');
  if(!exact(evidence,['staffId','accessSubject','verificationId','verifiedAt','expiresAt','issuer'])
    ||typeof evidence.staffId!=='string'||typeof evidence.accessSubject!=='string'
    ||typeof evidence.verificationId!=='string'||typeof evidence.verifiedAt!=='string'
    ||typeof evidence.expiresAt!=='string'||typeof evidence.issuer!=='string')throw Error('native_directory_maintenance_authority_denied');
  if(!exact(snapshotValue,Object.keys(tables)))throw Error('native_directory_maintenance_authority_denied');
  const snapshotRecord=snapshotValue;
  function parseRows(name:keyof typeof tables):Row[]{
    const source=snapshotRecord[name],spec=tables[name];
    if(!Array.isArray(source)||source.length>spec.limit)throw Error('native_directory_maintenance_authority_denied');
    return source.map((item:unknown)=>{
      const names=spec.columns.split(',');
      if(!exact(item,names))throw Error('native_directory_maintenance_authority_denied');
      const row:Record<string,Scalar>={};
      for(const column of names){
        const field=item[column];
        if(field!==null&&typeof field!=='string'&&!(typeof field==='number'&&Number.isSafeInteger(field)))
          throw Error('native_directory_maintenance_authority_denied');
        row[column]=field;
      }
      return row;
    });
  }
  const snapshot:Snapshot={staff:parseRows('staff'),admission:parseRows('admission'),profile:parseRows('profile'),
    roles:parseRows('roles'),grants:parseRows('grants'),history:parseRows('history'),generation:parseRows('generation')};
  const input:NativeDirectoryMaintenancePlanInput={
    target:{environment:'staging',accountLabel:target.accountLabel,workerLabel:target.workerLabel,databaseLabel:target.databaseLabel},
    staffId:value.staffId,grantId:value.grantId,commandId,
    operator:{staffId:operator.staffId,accessSubject:operator.accessSubject},
    approvalIssuer:{staffId:approvalIssuer.staffId,accessSubject:approvalIssuer.accessSubject},
    identityEvidence:{staffId:evidence.staffId,accessSubject:evidence.accessSubject,
      verificationId:evidence.verificationId,verifiedAt:evidence.verifiedAt,
      expiresAt:evidence.expiresAt,issuer:evidence.issuer},
  };
  const plan:NativeDirectoryMaintenanceAuthorityPlan={...input,protocol:'native-directory-maintenance-authority',version:1,snapshot};
  validatePlan(plan);
  const canonicalPlanJson=canonical(plan),independentBindingVerificationJson=canonical(plan.identityEvidence);
  if(canonicalPlanJson!==json||await sha(canonicalPlanJson)!==canonicalPlanSha256
    ||typeof raw.canonical_plan_sha256!=='string'||typeof raw.approved_operator_staff_id!=='string'
    ||typeof raw.approved_operator_access_subject!=='string'||typeof raw.independent_binding_verification_json!=='string'
    ||typeof raw.independent_binding_verification_sha256!=='string'||typeof raw.issued_by_staff_id!=='string'
    ||typeof raw.issued_by_access_subject!=='string'||raw.canonical_plan_sha256!==canonicalPlanSha256
    ||raw.approved_operator_staff_id!==plan.operator.staffId||raw.approved_operator_access_subject!==plan.operator.accessSubject
    ||raw.issued_by_staff_id!==plan.approvalIssuer.staffId||raw.issued_by_access_subject!==plan.approvalIssuer.accessSubject
    ||raw.independent_binding_verification_json!==independentBindingVerificationJson
    ||await sha(independentBindingVerificationJson)!==raw.independent_binding_verification_sha256)fail();
  return {approvalId,plan,canonicalPlanSha256};
}
function rowFence(db:D1DatabaseSession,commandId:string,name:keyof typeof tables,staffId:string,rows:readonly Row[],excludeGrantId?:string){
  const t=tables[name],columns=t.columns.split(','),match=columns.map(c=>`a.${c} COLLATE BINARY IS json_extract(e.value,'$.${c}') COLLATE BINARY`).join(' AND ');
  const exclusion=excludeGrantId?(name==='grants'?' AND id<>?':' AND grant_id<>?'):'';
  const values:Scalar[]=excludeGrantId?[staffId,excludeGrantId,canonical(rows),staffId,excludeGrantId,canonical(rows)]:[staffId,canonical(rows),staffId,canonical(rows)];
  return guard(db,commandId,`(SELECT COUNT(*) FROM ${t.name} WHERE ${t.key}=?${exclusion})=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM ${t.name} a WHERE a.${t.key}=?${exclusion} AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE ${match}))`,values);
}
function guard(db:D1DatabaseSession,id:string,predicate:string,values:Scalar[]){
  return db.prepare(`INSERT INTO native_directory_maintenance_authority_guards(command_id,ok) VALUES(?,CASE WHEN (${predicate}) THEN 1 ELSE 0 END) ON CONFLICT(command_id) DO UPDATE SET ok=excluded.ok`).bind(id,...values);
}
/** Local maintenance only: never installs approval, authenticates a browser,
 * updates an existing grant, changes billing authority, or restores revoked access. */
export async function executeNativeDirectoryMaintenanceAuthority(db:D1Database,input:Readonly<{
  plan:NativeDirectoryMaintenanceAuthorityPlan;approvalId:string;commandId:string;actor:Actor;target:NativeDirectoryMaintenanceTarget;
}>):Promise<NativeDirectoryMaintenanceAuthorityResult>{
  const {plan,actor,approvalId,commandId,target}=input;validatePlan(plan);
  if(!valid(approvalId)||!valid(commandId)||commandId!==plan.commandId||canonical(target)!==canonical(plan.target)||target.environment!=='staging'
    ||actor.identity.kind!=='native'||actor.identity.staffId!==plan.operator.staffId||actor.identity.verifiedAccessSubject!==plan.operator.accessSubject
    ||actor.admissionVersion!==plan.snapshot.admission[0]!.version||actor.identity.profileVersion!==plan.snapshot.profile[0]!.version)fail();
  const planJson=canonical(plan),planHash=await sha(planJson),evidenceJson=canonical(plan.identityEvidence),evidenceHash=await sha(evidenceJson);
  const session=db.withSession('first-primary');
  const resultingGeneration=Number(plan.snapshot.generation[0]?.generation??0)+1;
  const result={commandId,approvalId,grantId:plan.grantId,resultingGeneration},resultJson=canonical(result),resultHash=await sha(resultJson);
  const authority=()=>guard(session,commandId,`EXISTS(SELECT 1 FROM native_directory_maintenance_authority_approvals p
    WHERE p.approval_id=? AND p.canonical_plan_json=? AND p.canonical_plan_sha256=?
      AND p.approved_operator_staff_id=? AND p.approved_operator_access_subject=?
      AND p.issued_by_staff_id=? AND p.issued_by_access_subject=?
      AND p.independent_binding_verification_json=? AND p.independent_binding_verification_sha256=?
      AND p.revoked_at IS NULL AND julianday(p.issued_at)<=julianday('now') AND julianday(p.expires_at)>julianday('now')
      AND julianday(p.expires_at)-julianday(p.issued_at)<=1.0/24)
    AND julianday(?)<=julianday('now') AND julianday(?)>julianday('now')
    AND EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
      WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=? AND p.version=?
        AND s.status='active' AND s.access_subject=? AND julianday(?)>julianday('now')
        AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=a.staff_id AND r.role_id='role-owner' AND r.scope='global')
        AND NOT EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=a.staff_id AND g.permission='directory.portal_access.manage' AND g.effect='deny' AND g.active=1))`,
    [approvalId,planJson,planHash,plan.operator.staffId,plan.operator.accessSubject,plan.approvalIssuer.staffId,plan.approvalIssuer.accessSubject,evidenceJson,evidenceHash,plan.identityEvidence.verifiedAt,plan.identityEvidence.expiresAt,
      plan.staffId,plan.operator.accessSubject,actor.admissionVersion,actor.identity.profileVersion,plan.operator.accessSubject,actor.verifiedUntil]);
  const receiptFence=()=>guard(session,commandId,`EXISTS(SELECT 1 FROM native_directory_maintenance_authority_receipts WHERE command_id=? AND approval_id=?
    AND operator_staff_id=? AND operator_access_subject=? AND canonical_plan_json=? AND canonical_plan_sha256=?
    AND independent_binding_verification_json=? AND independent_binding_verification_sha256=? AND grant_id=? AND resulting_generation=? AND result_json=? AND result_sha256=?)`,
    [commandId,approvalId,plan.operator.staffId,plan.operator.accessSubject,planJson,planHash,evidenceJson,evidenceHash,plan.grantId,resultingGeneration,resultJson,resultHash]);
  const cleanup=session.prepare('DELETE FROM native_directory_maintenance_authority_guards WHERE command_id=?').bind(commandId);
  const enter=()=>session.prepare('INSERT INTO native_directory_maintenance_authority_guards(command_id,ok) VALUES(?,1)').bind(commandId);
  const prior=await session.prepare('SELECT command_id FROM native_directory_maintenance_authority_receipts WHERE command_id=? OR approval_id=?').bind(commandId,approvalId).first();
  if(prior){try{await session.batch([enter(),authority(),receiptFence(),cleanup]);return {status:'replayed',...result};}catch{return fail();}}
  const statements=[enter(),authority(),...((Object.keys(tables) as (keyof typeof tables)[]).map(name=>rowFence(session,commandId,name,plan.staffId,plan.snapshot[name]))),
    session.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,granted_by)
      VALUES(?,?,'directory.portal_access.manage','allow','global',NULL,NULL,NULL,1,?)`).bind(plan.grantId,plan.staffId,plan.operator.staffId),
    ...(['staff','admission','profile','roles','grants','history'] as const).map(name=>rowFence(session,commandId,name,plan.staffId,plan.snapshot[name],name==='grants'||name==='history'?plan.grantId:undefined)),
    authority(),guard(session,commandId,`EXISTS(SELECT 1 FROM native_directory_grant_generations WHERE staff_id=? AND generation=?)
      AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=? AND staff_id=? AND permission='directory.portal_access.manage' AND effect='allow' AND scope_kind='global' AND active=1 AND granted_by=?)
      AND EXISTS(SELECT 1 FROM native_directory_grant_history WHERE grant_id=? AND grant_version=1 AND grant_generation=? AND active=1)`,
      [plan.staffId,resultingGeneration,plan.grantId,plan.staffId,plan.operator.staffId,plan.grantId,resultingGeneration]),
    session.prepare(`INSERT INTO native_directory_maintenance_authority_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,
      canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,grant_id,resulting_generation,result_json,result_sha256)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(commandId,approvalId,plan.operator.staffId,plan.operator.accessSubject,planJson,planHash,evidenceJson,evidenceHash,plan.grantId,resultingGeneration,resultJson,resultHash),
    receiptFence(),authority(),
    ...(['staff','admission','profile','roles','grants','history'] as const).map(name=>rowFence(session,commandId,name,plan.staffId,plan.snapshot[name],name==='grants'||name==='history'?plan.grantId:undefined)),
    guard(session,commandId,`EXISTS(SELECT 1 FROM native_directory_grant_generations WHERE staff_id=? AND generation=?) AND EXISTS(SELECT 1 FROM native_directory_grants WHERE id=? AND active=1)`,[plan.staffId,resultingGeneration,plan.grantId]),cleanup];
  try{await session.batch(statements);return {status:'applied',...result};}catch{
    // Only a genuinely committed exact winner may replay after a race. All
    // authority and immutable receipt bytes are rechecked in another transaction.
    try{await session.batch([enter(),authority(),receiptFence(),cleanup]);return {status:'replayed',...result};}catch{return fail();}
  }
}
