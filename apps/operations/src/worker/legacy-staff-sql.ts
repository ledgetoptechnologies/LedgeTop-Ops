// SQL fragments for the legacy (pre-cutover) Team staff writer: POST /api/admin/staff and
// PATCH /api/admin/staff/:id. Each is evaluated inside the write batch as a json('') guard.

/** Rows that belong to the native lifecycle (admission, profile or native onboarding provenance). */
export const nativeLifecycleSql = (staff: string) => `(EXISTS(SELECT 1 FROM native_staff_admissions native_admission WHERE native_admission.staff_id=${staff}.id)
  OR EXISTS(SELECT 1 FROM native_staff_profiles native_profile WHERE native_profile.staff_id=${staff}.id)
  OR EXISTS(SELECT 1 FROM native_staff_pending_onboarding native_onboarding WHERE native_onboarding.proposed_staff_id=${staff}.id))`;

/** Exactly the isAdministrator predicate (acl.ts prepareAclAdministratorRead): a global owner/admin row in staff_role_assignments. */
export const administratorSql = (staff: string) => `EXISTS(SELECT 1 FROM staff_role_assignments administrator_role
  WHERE administrator_role.staff_id=${staff}.id AND administrator_role.role_id IN ('role-owner','role-admin') AND administrator_role.scope='global')`;

/** Binds: target id, target id. True unless the target is an administrator and no other active administrator remains. */
export const legacyStaffAnotherAdministratorSql = `(NOT EXISTS(SELECT 1 FROM staff_users target WHERE target.id=? AND ${administratorSql("target")})
  OR EXISTS(SELECT 1 FROM staff_users other WHERE other.id<>? AND other.status='active' AND ${administratorSql("other")}))`;

/** Binds: actor id. The acting administrator is still active, an administrator, and holds global roles.manage with no global deny. */
export const legacyStaffActorSql = `EXISTS(SELECT 1 FROM staff_users actor WHERE actor.id=? AND actor.status='active'
  AND ${administratorSql("actor")}
  AND (EXISTS(SELECT 1 FROM staff_role_assignments actor_role JOIN role_permissions actor_permission ON actor_permission.role_id=actor_role.role_id
        WHERE actor_role.staff_id=actor.id AND actor_role.scope='global' AND actor_permission.permission_key='roles.manage')
    OR EXISTS(SELECT 1 FROM local_staff_role_assignments actor_role JOIN role_permissions actor_permission ON actor_permission.role_id=actor_role.role_id
        WHERE actor_role.staff_id=actor.id AND actor_role.scope='global' AND actor_permission.permission_key='roles.manage')
    OR EXISTS(SELECT 1 FROM staff_permission_overrides actor_allow WHERE actor_allow.staff_id=actor.id
        AND actor_allow.permission_key='roles.manage' AND actor_allow.effect='allow' AND actor_allow.scope='global'))
  AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides actor_deny WHERE actor_deny.staff_id=actor.id
        AND actor_deny.permission_key='roles.manage' AND actor_deny.effect='deny' AND actor_deny.scope='global'))`;

/** Pre-cutover only. A schema without the 0225 control table is pre-cutover (as in auth.ts). */
export const legacyStaffPreCutoverSql = (controlTablePresent: boolean) => controlTablePresent
  ? "EXISTS(SELECT 1 FROM native_staff_access_reconciliation WHERE singleton=1 AND enabled=0)" : "1";

/** Binds: email, email. An email reserved by a non-terminal or approved native onboarding, or held by a native profile. */
export const nativeReservedEmailSql = `(EXISTS(SELECT 1 FROM native_staff_pending_onboarding reserved_onboarding
    WHERE reserved_onboarding.login_email=? COLLATE NOCASE AND reserved_onboarding.state IN ('pending','claimed','approved'))
  OR EXISTS(SELECT 1 FROM native_staff_profiles reserved_profile WHERE reserved_profile.login_email=? COLLATE NOCASE))`;

/** A global role-admin or role-owner in either role table (reactivating such a row needs an owner). */
export const anyGlobalAdministratorRoleSql = (staff: string) => `(EXISTS(SELECT 1 FROM staff_role_assignments held_role
    WHERE held_role.staff_id=${staff}.id AND held_role.role_id IN ('role-owner','role-admin') AND held_role.scope='global')
  OR EXISTS(SELECT 1 FROM local_staff_role_assignments held_role
    WHERE held_role.staff_id=${staff}.id AND held_role.role_id IN ('role-owner','role-admin') AND held_role.scope='global'))`;

/** Binds: target id, actor id. True unless the target holds an administrator role and the actor is not a global owner. */
export const legacyStaffReactivationAllowedSql = `(NOT EXISTS(SELECT 1 FROM staff_users reactivated WHERE reactivated.id=? AND ${anyGlobalAdministratorRoleSql("reactivated")})
  OR EXISTS(SELECT 1 FROM staff_role_assignments owner_actor WHERE owner_actor.staff_id=? AND owner_actor.role_id='role-owner' AND owner_actor.scope='global'))`;
