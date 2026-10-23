import { isNativeAccessSubject } from "./native-access-subject";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const CAPS = ["staff.profile.edit", "staff.admission.enable", "staff.admission.disable"] as const;
type Capability = typeof CAPS[number];
type Command = { commandId:string; contractVersion:1; capability:Capability; actor:{staffId:string;verifiedAccessSubject:string}; targetStaffId:string; expectedVersion:number; reason:string; displayName?:string };
export type NativeStaffManagementCommandReceipt = { commandId:string; contractVersion:1; capability:Capability; targetStaffId:string; resultVersion:number; replayed:boolean };

function plain(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==="object"&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return typeof k==="string"&&d?.enumerable===true&&"value" in d;});}
function exact(v:Record<string,unknown>,ks:string[]){return Object.keys(v).length===ks.length&&ks.every(k=>Object.hasOwn(v,k));}
function id(v:unknown):v is string{return typeof v==="string"&&ID.test(v)&&!/\p{C}/u.test(v);}
function normalize(v:unknown):Command{
  if(!plain(v)||!plain(v.actor)||!exact(v.actor,["staffId","verifiedAccessSubject"])||!id(v.commandId)||v.contractVersion!==1||!CAPS.includes(v.capability as Capability)||!id(v.actor.staffId)||!isNativeAccessSubject(v.actor.verifiedAccessSubject)||!id(v.targetStaffId)||typeof v.expectedVersion!=="number"||!Number.isSafeInteger(v.expectedVersion)||v.expectedVersion<1||v.expectedVersion>=Number.MAX_SAFE_INTEGER||typeof v.reason!=="string"||v.reason!==v.reason.trim()||v.reason.length<1||v.reason.length>500||/\p{C}/u.test(v.reason))throw Error("native_staff_management_command_denied");
  const edit=v.capability==="staff.profile.edit", keys=["commandId","contractVersion","capability","actor","targetStaffId","expectedVersion","reason",...(edit?["displayName"]:[])];
  if(!exact(v,keys)||(edit&&(typeof v.displayName!=="string"||v.displayName!==v.displayName.trim()||v.displayName.length<1||v.displayName.length>160||/\p{C}/u.test(v.displayName))))throw Error("native_staff_management_command_denied");
  return {commandId:v.commandId,contractVersion:1,capability:v.capability as Capability,actor:{staffId:v.actor.staffId,verifiedAccessSubject:v.actor.verifiedAccessSubject},targetStaffId:v.targetStaffId,expectedVersion:v.expectedVersion,reason:v.reason,...(edit?{displayName:v.displayName as string}:{})};
}
async function hash(v:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");}
const SCOPE=`(d.scope_kind='global' OR (d.scope_kind='exact_staff' AND d.target_staff_id=?) OR (d.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_staff_target_memberships m WHERE m.staff_id=? AND m.active=1 AND m.business_area_id=d.business_area_id)) OR (d.scope_kind='division' AND EXISTS(SELECT 1 FROM native_staff_target_memberships m WHERE m.staff_id=? AND m.active=1 AND m.business_area_id=d.business_area_id AND m.division_id=d.division_id)))`;
const AUTH=`EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=?)
AND EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id WHERE a.staff_id=?)
AND EXISTS(SELECT 1 FROM native_staff_management_delegations d WHERE d.actor_staff_id=? AND d.contract_version=1 AND d.capability=? AND d.effect='allow' AND d.active=1 AND ${SCOPE}
 UNION ALL SELECT 1 FROM native_staff_admin_delegations d WHERE d.actor_staff_id=? AND d.action=? AND d.effect='allow' AND d.active=1 AND ${SCOPE})
AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations d WHERE d.actor_staff_id=? AND d.contract_version=1 AND d.capability=? AND d.effect='deny' AND d.active=1 AND ${SCOPE}
 UNION ALL SELECT 1 FROM native_staff_admin_delegations d WHERE d.actor_staff_id=? AND d.action=? AND d.effect='deny' AND d.active=1 AND ${SCOPE})
AND NOT EXISTS(SELECT 1 FROM native_staff_target_memberships m LEFT JOIN native_business_areas a ON a.id=m.business_area_id LEFT JOIN native_business_divisions d ON d.id=m.division_id AND d.business_area_id=m.business_area_id WHERE m.staff_id=? AND m.active=1 AND (coalesce(a.active,0)<>1 OR (m.scope_kind='business_area' AND m.division_id IS NOT NULL) OR (m.scope_kind='division' AND (m.division_id IS NULL OR coalesce(d.active,0)<>1))))`;
function binds(c:Command){const a=c.actor.staffId,t=c.targetStaffId,x=c.capability;return[a,c.actor.verifiedAccessSubject,t,a,x,t,t,t,a,x,t,t,t,a,x,t,t,t,a,x,t,t,t,t];}

export type OperationsStaffLifecycleAuthority = Readonly<{ admissionVersion: number; profileVersion: number; verifiedUntil: string }>;

/** Historical native-only service. HTTP routes use the joined entrypoint. */
export async function executeNativeStaffManagementCommand(database:D1Database,input:unknown):Promise<NativeStaffManagementCommandReceipt>{
  return execute(database,input);
}

/** Does not bootstrap identity/grants, bind by email, or enable cutover. The
 * current actor and exact bridge identities are rechecked in 0225's fence;
 * 0069's scoped delegations, denies and last-control-plane guard still apply. */
export async function executeOperationsStaffLifecycleCommand(database:D1Database,input:unknown,
  authority:OperationsStaffLifecycleAuthority):Promise<NativeStaffManagementCommandReceipt>{
  try {
    if(!plain(authority)||!exact(authority,["admissionVersion","profileVersion","verifiedUntil"])
      ||!Number.isSafeInteger(authority.admissionVersion)||authority.admissionVersion<1
      ||!Number.isSafeInteger(authority.profileVersion)||authority.profileVersion<1
      ||typeof authority.verifiedUntil!=="string"||!Number.isSafeInteger(Date.parse(authority.verifiedUntil))
      ||Date.parse(authority.verifiedUntil)<=Date.now())throw Error();
    return await execute(database,input,Object.freeze({admissionVersion:authority.admissionVersion,
      profileVersion:authority.profileVersion,verifiedUntil:authority.verifiedUntil}));
  }catch{throw Error("operations_staff_lifecycle_denied");}
}

async function execute(database:D1Database,input:unknown,authority?:OperationsStaffLifecycleAuthority):Promise<NativeStaffManagementCommandReceipt>{try{
  const c=normalize(input), requestHash=await hash(JSON.stringify(c)), resultVersion=c.expectedVersion+1;
  const result=JSON.stringify({contractVersion:1,capability:c.capability,targetStaffId:c.targetStaffId,resultVersion,...(c.capability==="staff.profile.edit"?{displayName:c.displayName}:{})}), resultHash=await hash(result), db=database.withSession("first-primary");
  // Current proof is required for replay; a historical receipt never repeats a
  // transition after a subsequent disable/re-enable.
  const bridgeAuthority=authority?` AND EXISTS(SELECT 1 FROM native_staff_access_reconciliation WHERE singleton=1 AND enabled=1)
    AND EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
      WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=? AND p.version=?
        AND s.status='active' AND s.access_subject=a.bound_access_subject AND s.email=p.login_email COLLATE BINARY)
    AND EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
      WHERE a.staff_id=? AND s.access_subject=a.bound_access_subject AND s.email=p.login_email COLLATE BINARY
        AND s.status=CASE a.active WHEN 1 THEN 'active' ELSE 'inactive' END)
    AND ? > CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`:"";
  const bridgeBinds=authority?[c.actor.staffId,c.actor.verifiedAccessSubject,authority.admissionVersion,authority.profileVersion,c.targetStaffId,Date.parse(authority.verifiedUntil)]:[];
  const prior=await db.prepare(`SELECT request_sha256,contract_version,capability,target_staff_id,result_version FROM native_staff_management_commands WHERE command_id=? AND ${AUTH}${bridgeAuthority}`).bind(c.commandId,...binds(c),...bridgeBinds).first<Record<string,unknown>>();
  if(prior){if(!plain(prior)||prior.request_sha256!==requestHash||prior.contract_version!==1||prior.capability!==c.capability||prior.target_staff_id!==c.targetStaffId||prior.result_version!==resultVersion)throw Error();return Object.freeze({commandId:c.commandId,contractVersion:1,capability:c.capability,targetStaffId:c.targetStaffId,resultVersion,replayed:true});}
  const display=c.capability==="staff.profile.edit"?c.displayName:null;
  const fence=db.prepare(`INSERT INTO native_staff_management_fences(command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${AUTH} AND ((?='staff.profile.edit' AND EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=? AND version=?)) OR (?='staff.admission.disable' AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=? AND active=1 AND version=?)) OR (?='staff.admission.enable' AND EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=? AND active=0 AND version=?)))`).bind(c.commandId,requestHash,1,c.capability,c.actor.staffId,c.actor.verifiedAccessSubject,c.targetStaffId,c.expectedVersion,resultVersion,c.reason,display,result,resultHash,...binds(c),c.capability,c.targetStaffId,c.expectedVersion,c.capability,c.targetStaffId,c.expectedVersion,c.capability,c.targetStaffId,c.expectedVersion);
  const mutation=c.capability==="staff.profile.edit"?db.prepare("UPDATE native_staff_profiles SET display_name=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=? AND version=? AND EXISTS(SELECT 1 FROM native_staff_management_fences WHERE command_id=?)").bind(c.displayName,c.targetStaffId,c.expectedVersion,c.commandId):db.prepare("UPDATE native_staff_admissions SET active=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=? AND active=? AND version=? AND EXISTS(SELECT 1 FROM native_staff_management_fences WHERE command_id=?)").bind(c.capability==="staff.admission.enable"?1:0,c.targetStaffId,c.capability==="staff.admission.enable"?0:1,c.expectedVersion,c.commandId);
  const receipt=db.prepare("INSERT INTO native_staff_management_commands(command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(c.commandId,requestHash,1,c.capability,c.actor.staffId,c.actor.verifiedAccessSubject,c.targetStaffId,c.expectedVersion,resultVersion,c.reason,display,result,resultHash);
  const statements=[fence,mutation,receipt];
  if(authority){
    const joinedFence=db.prepare(`INSERT INTO native_staff_lifecycle_fences(command_id,capability,actor_staff_id,actor_access_subject,
      actor_admission_version,actor_profile_version,verified_until_ms,target_staff_id,expected_version) VALUES(?,?,?,?,?,?,?,?,?)`)
      .bind(c.commandId,c.capability,c.actor.staffId,c.actor.verifiedAccessSubject,authority.admissionVersion,
        authority.profileVersion,Date.parse(authority.verifiedUntil),c.targetStaffId,c.expectedVersion);
    const bridge=c.capability==="staff.profile.edit"?
      db.prepare(`UPDATE staff_users SET display_name=?,updated_at=datetime('now') WHERE id=?
        AND EXISTS(SELECT 1 FROM native_staff_lifecycle_fences WHERE command_id=? AND bridge_writes=1)`)
        .bind(c.displayName,c.targetStaffId,c.commandId):
      db.prepare(`UPDATE staff_users SET status=?,updated_at=datetime('now') WHERE id=?
        AND EXISTS(SELECT 1 FROM native_staff_lifecycle_fences WHERE command_id=? AND bridge_writes=1)`)
        .bind(c.capability==="staff.admission.enable"?"active":"inactive",c.targetStaffId,c.commandId);
    statements.splice(0,0,joinedFence);
    statements.splice(3,0,bridge);
    if(c.capability!=="staff.profile.edit")statements.push(db.prepare(`INSERT INTO native_staff_access_reconciliation_events
      (command_id,staff_id,admission_version,desired_active,generation) SELECT ?,?,?,?,generation+1 FROM native_staff_access_reconciliation WHERE singleton=1`)
      .bind(c.commandId,c.targetStaffId,resultVersion,c.capability==="staff.admission.enable"?1:0));
    statements.push(db.prepare("DELETE FROM native_staff_lifecycle_fences WHERE command_id=?").bind(c.commandId));
  }
  const batch:unknown=await db.batch(statements);if(!Array.isArray(batch)||batch.length!==statements.length)throw Error();for(const row of batch)if(!plain(row)||row.success!==true)throw Error();return Object.freeze({commandId:c.commandId,contractVersion:1,capability:c.capability,targetStaffId:c.targetStaffId,resultVersion,replayed:false});
}catch{throw Error("native_staff_management_command_denied");}}
