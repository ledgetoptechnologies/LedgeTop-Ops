export type DirectoryCreateRecoveryCurrentActor={staffId:string;accessSubject:string;email:string;admissionVersion:number;profileVersion:number};
export async function directoryCreateRecoveryGrant(db:D1Database,staff:string,permission:string,record:string):Promise<string|null>{return db.withSession("first-primary")
  .prepare(`SELECT allow_grant.id FROM native_directory_grants allow_grant WHERE allow_grant.staff_id=?
    AND allow_grant.permission=? AND allow_grant.effect='allow' AND allow_grant.active=1
    AND (allow_grant.scope_kind='global' OR allow_grant.scope_kind='resource' AND allow_grant.resource_id=?
      OR allow_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=? AND a.staff_id=? AND a.active=1)
      OR allow_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.business_area_id=allow_grant.business_area_id)
      OR allow_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.division_id=allow_grant.division_id))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=? AND deny.permission=? AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR deny.scope_kind='resource' AND deny.resource_id=?
        OR deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=? AND a.staff_id=? AND a.active=1)
        OR deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.business_area_id=deny.business_area_id)
        OR deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.division_id=deny.division_id)))
    ORDER BY CASE allow_grant.scope_kind WHEN 'resource' THEN 1 WHEN 'division' THEN 2 WHEN 'business_area' THEN 3 WHEN 'assigned' THEN 4 ELSE 5 END,allow_grant.id LIMIT 1`)
  .bind(staff,permission,record,record,staff,record,record,staff,permission,record,record,staff,record,record).first<string>("id");}
export async function directoryCreateRecoveryActorCurrent(db:D1Database,actor:DirectoryCreateRecoveryCurrentActor):Promise<boolean>{return !!await db.withSession("first-primary")
  .prepare(`SELECT 1 present FROM staff_users staff JOIN native_staff_admissions admission ON admission.staff_id=staff.id
    JOIN native_staff_profiles profile ON profile.staff_id=staff.id WHERE staff.id=? AND staff.status='active'
    AND staff.access_subject=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
    AND profile.login_email=? AND profile.version=?`).bind(actor.staffId,actor.accessSubject,actor.accessSubject,
      actor.admissionVersion,actor.email,actor.profileVersion).first();}

export type DirectoryCreateRecoveryReservationProof={profileGrantId:string;identityGrantId:string;enrollmentGrantId:string;
  rootCommandJson:string;rootCommandId:string;authorizationId:string};
/** Presend-only validator. Historical acknowledgements must use the immutable
 * ledger without requiring these current grants to remain active. */
export async function validateDirectoryCreateRecoveryReservation(db:D1Database,commandId:string,
  actor:DirectoryCreateRecoveryCurrentActor):Promise<DirectoryCreateRecoveryReservationProof|null>{
  if(!await directoryCreateRecoveryActorCurrent(db,actor))return null;
  const row=await db.withSession("first-primary").prepare(`SELECT recovery.authorization_id,recovery.root_command_id,
      root.command_json root_command_json,recovery.record_id,recovery.actor_staff_id,recovery.actor_access_subject,
      recovery.actor_email,recovery.actor_admission_version,recovery.actor_profile_version,recovery.profile_grant_id,
      recovery.identity_grant_id,recovery.enrollment_grant_id
    FROM project_alpha_directory_create_generation_recoveries recovery
    JOIN project_alpha_directory_outbox root ON root.command_id=recovery.root_command_id
    JOIN native_staff_admissions admission ON admission.staff_id=recovery.actor_staff_id
      AND admission.active=1 AND admission.bound_access_subject=recovery.actor_access_subject
      AND admission.version=recovery.actor_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=recovery.actor_staff_id
      AND profile.login_email=recovery.actor_email AND profile.version=recovery.actor_profile_version
    WHERE recovery.successor_command_id=?`).bind(commandId).first<Record<string,unknown>>();
  if(!row||row.actor_staff_id!==actor.staffId||row.actor_access_subject!==actor.accessSubject||row.actor_email!==actor.email
    ||row.actor_admission_version!==actor.admissionVersion||row.actor_profile_version!==actor.profileVersion)return null;
  const selected=await Promise.all([directoryCreateRecoveryGrant(db,actor.staffId,"directory.profile.edit",String(row.record_id)),
    directoryCreateRecoveryGrant(db,actor.staffId,"directory.identity.link",String(row.record_id)),directoryCreateRecoveryGrant(db,actor.staffId,"directory.enrollment.manage",String(row.record_id))]);
  if(selected[0]!==row.profile_grant_id||selected[1]!==row.identity_grant_id||selected[2]!==row.enrollment_grant_id)return null;
  return{profileGrantId:selected[0]!,identityGrantId:selected[1]!,enrollmentGrantId:selected[2]!,
    rootCommandJson:String(row.root_command_json),rootCommandId:String(row.root_command_id),authorizationId:String(row.authorization_id)};
}

