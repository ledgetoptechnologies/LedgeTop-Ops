export interface PortalAutomaticEligibilityEnv {
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED?: string;
  CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED?: string;
  CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED?: string;
  CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED?: string;
}

/**
 * Keep automatic portal eligibility fail-closed until both applications have
 * the hierarchy and denial controls needed to revoke that access safely.
 */
export function portalAutomaticEligibilityEnabled(env: PortalAutomaticEligibilityEnv): boolean {
  return env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true" &&
    env.CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED === "true" &&
    env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" &&
    env.CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED === "true";
}
