import type { Permission } from "@ltds/shared";

export const STAFF_ACCESS_CONTROLS = {
  allOperations: ["operations.view_all"],
  sopAssignment: ["sops.assign"],
  deliveryBrowse: ["delivery.browse"],
  deliveryLinkCreate: ["delivery.share.create"],
  deliveryLinkRevoke: ["delivery.share.revoke"],
  deliveryLinkAudit: ["delivery.share.audit"],
  teamRoster: ["team.view"],
  administration: ["administration.view"],
} as const satisfies Record<string, readonly Permission[]>;

export type StaffAccessControl = keyof typeof STAFF_ACCESS_CONTROLS;
export type StaffAccessControlValues = Record<StaffAccessControl, boolean>;

function permissionSet(value: string | null | undefined): Set<string> {
  return new Set(String(value || "").split(",").filter(Boolean));
}

export function staffAccessControlEffect(enabled: boolean): "allow" | "deny" {
  return enabled ? "allow" : "deny";
}

/** Resolve the same effective state enforced by acl.ts: a global direct deny
 * wins over every inherited or direct allow. */
export function effectiveStaffAccessControls(input: {
  inheritedPermissions?: string | null;
  directAllows?: string | null;
  globalDenies?: string | null;
}): StaffAccessControlValues {
  const allowed = permissionSet(input.inheritedPermissions);
  for (const permission of permissionSet(input.directAllows)) allowed.add(permission);
  const denied = permissionSet(input.globalDenies);
  return Object.fromEntries(Object.entries(STAFF_ACCESS_CONTROLS).map(([control, permissions]) => [
    control,
    permissions.every(permission => allowed.has(permission) && !denied.has(permission)),
  ])) as StaffAccessControlValues;
}
