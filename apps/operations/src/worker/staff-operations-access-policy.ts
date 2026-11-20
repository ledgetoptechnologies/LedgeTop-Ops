import type { Permission } from "@ltds/shared";

/* ========================= REVIEW DEFAULTS (policy) =========================
 * The native staff Operations-access writer's reviewed policy, in one place.
 * Migration 0244 enforces the same values in SQL (its catalog seed and the
 * "REVIEW DEFAULT" clauses of staff_operations_access_command_authorize).
 * Mounted tests fail if this file and the installed catalog disagree, and if
 * any hasLocalGlobalAllow / prepareAclLocalGlobalAllowRead key in src is not
 * flagged requiresExplicitActorAllow. Changing a value here needs the matching
 * migration change and a new review.
 *
 * - Grantable set: STAFF_ACCESS_CONTROLS minus viewer.storage.purge (owner-only).
 *   roles.manage and administration.manage are never grantable.
 * - requiresExplicitActorAllow: the actor's ceiling for this key is its own
 *   explicit global override allow; a role-derived allow does not count.
 * - Writer gate: global role-owner/role-admin AND global roles.manage, with no
 *   roles.manage deny at any scope.
 * - Ceiling: grant AND revoke need the actor's global allow for the permission
 *   with no deny for it at any scope.
 * - No deny writer, no division-scoped writer, no runtime switch.
 * ========================================================================== */
export const STAFF_OPERATIONS_ACCESS_CATALOG = Object.freeze([
  { permission: "operations.view_all", requiresExplicitActorAllow: true },
  { permission: "sops.assign", requiresExplicitActorAllow: false },
  { permission: "delivery.browse", requiresExplicitActorAllow: false },
  { permission: "delivery.share.create", requiresExplicitActorAllow: false },
  { permission: "delivery.share.revoke", requiresExplicitActorAllow: false },
  { permission: "delivery.share.audit", requiresExplicitActorAllow: false },
  { permission: "team.view", requiresExplicitActorAllow: false },
  { permission: "administration.view", requiresExplicitActorAllow: false },
  { permission: "viewer.view", requiresExplicitActorAllow: false },
  { permission: "viewer.datasets.manage", requiresExplicitActorAllow: false },
  { permission: "viewer.processing.manage", requiresExplicitActorAllow: false },
  { permission: "viewer.publish", requiresExplicitActorAllow: false },
  { permission: "viewer.share.create", requiresExplicitActorAllow: false },
  { permission: "viewer.share.revoke", requiresExplicitActorAllow: false },
  { permission: "viewer.manage", requiresExplicitActorAllow: false },
] as const satisfies ReadonlyArray<{ permission: Permission; requiresExplicitActorAllow: boolean }>);

/** The writer gate (global role-owner/role-admin plus roles.manage) and the
 * revoke ceiling are fixed behaviour of the 0244 authorize trigger and of
 * evaluate() in staff-operations-access.ts; they are not switches here. */
export const STAFF_OPERATIONS_ACCESS_POLICY = Object.freeze({
  managementPermission: "roles.manage" as const,
});
/* ======================= END REVIEW DEFAULTS (policy) ===================== */

export type StaffOperationsAccessPermission = typeof STAFF_OPERATIONS_ACCESS_CATALOG[number]["permission"];
