import type {StaffPrincipal} from './types';
import {assertCurrentStaffLogin} from './staff-login-bindings';

export type FinanceSummaryAuthority=Readonly<{
  staffId:string;subject:string;accessExpiresAt:number;profileVersion:number;admissionVersion:number;
}>;

/** A company aggregate cannot safely honor a partial/division grant. An
 * explicit deny at any scope blocks the aggregate, including for owners. */
export async function readFinanceSummaryAuthority(db:D1Database,principal:StaffPrincipal,now=Date.now()):Promise<FinanceSummaryAuthority|null>{
  if(principal.verifiedLogin&&!await assertCurrentStaffLogin(db,principal.verifiedLogin,Math.floor(now/1000)))return null;
  const staffId=principal.id,subject=principal.accessSubject,expires=principal.accessExpiresAt;
  if(typeof staffId!=='string'||typeof subject!=='string'||!subject
    ||typeof expires!=='number'||!Number.isSafeInteger(expires)||expires<=Math.floor(now/1000))return null;
  const row=await db.withSession('first-primary').prepare(`SELECT profile.version AS profileVersion,admission.version AS admissionVersion
    FROM staff_users staff JOIN native_staff_profiles profile ON profile.staff_id=staff.id
      AND profile.login_email=staff.email COLLATE NOCASE
    JOIN native_staff_admissions admission ON admission.staff_id=staff.id AND admission.active=1
      AND admission.bound_access_subject=staff.access_subject
    WHERE staff.id=? AND staff.access_subject=? AND staff.status='active'
      AND EXISTS(SELECT 1 FROM staff_role_assignments admin WHERE admin.staff_id=staff.id
        AND admin.scope='global' AND admin.role_id IN('role-owner','role-admin'))
      AND (EXISTS(SELECT 1 FROM staff_role_assignments a JOIN role_permissions p ON p.role_id=a.role_id
          WHERE a.staff_id=staff.id AND a.scope='global' AND p.permission_key='finance.summary.view')
        OR EXISTS(SELECT 1 FROM local_staff_role_assignments a JOIN role_permissions p ON p.role_id=a.role_id
          WHERE a.staff_id=staff.id AND a.scope='global' AND p.permission_key='finance.summary.view')
        OR EXISTS(SELECT 1 FROM staff_permission_overrides p WHERE p.staff_id=staff.id
          AND p.permission_key='finance.summary.view' AND p.scope='global' AND p.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides p WHERE p.staff_id=staff.id
        AND p.permission_key='finance.summary.view' AND p.effect='deny')
    LIMIT 1`).bind(staffId,subject).first<{profileVersion:number;admissionVersion:number}>();
  if(!row||!Number.isSafeInteger(row.profileVersion)||row.profileVersion<1
    ||!Number.isSafeInteger(row.admissionVersion)||row.admissionVersion<1)return null;
  return Object.freeze({staffId,subject,accessExpiresAt:expires,profileVersion:row.profileVersion,admissionVersion:row.admissionVersion});
}

/** Re-run after upstream awaits, immediately before disclosing any aggregate. */
export async function financeSummaryAuthorityStillCurrent(db:D1Database,expected:FinanceSummaryAuthority,principal:StaffPrincipal,now=Date.now()):Promise<boolean>{
  const current=await readFinanceSummaryAuthority(db,principal,now);
  return current!==null&&current.staffId===expected.staffId&&current.subject===expected.subject
    &&current.accessExpiresAt===expected.accessExpiresAt&&current.profileVersion===expected.profileVersion
    &&current.admissionVersion===expected.admissionVersion;
}
