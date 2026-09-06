// This committed declaration is release intent, not production approval or readback.
export const eligibilityFlags = Object.freeze([
  "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
  "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
  "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED",
  "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED",
  "CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED",
]);

const operationsMailFlags = Object.freeze([
  "AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED",
  "PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED",
]);

export function validatePortalReleaseProfile(declaration, clientConfig, operationsConfig) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration) ||
      declaration.schemaVersion !== 1 ||
      !["receiver-only", "default-on-eligibility"].includes(declaration.profile) ||
      Object.keys(declaration).some(key => !["schemaVersion", "profile"].includes(key))) {
    return ["Portal release profile must declare schemaVersion 1 and an explicit receiver-only or default-on-eligibility profile, with no extra fields"];
  }
  const errors = [];
  const expected = declaration.profile === "receiver-only" ? "false" : "true";
  for (const [label, config] of [["Client", clientConfig], ["Operations", operationsConfig]]) {
    if (!config?.vars || typeof config.vars !== "object" || Array.isArray(config.vars)) {
      errors.push(`${label} Wrangler config is missing vars`);
      continue;
    }
    for (const flag of eligibilityFlags) {
      const value = config.vars[flag];
      // Existing receiver-only Client config intentionally omits this optional flag.
      if (label === "Client" && declaration.profile === "receiver-only" &&
          flag === "CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED" && value === undefined) continue;
      if (value !== expected) errors.push(`${label} ${flag} must be exactly ${expected} for ${declaration.profile}`);
    }
    const mailFlags = label === "Client" ? ["CLIENT_PORTAL_INVITATION_EMAIL_ENABLED"] : operationsMailFlags;
    for (const flag of mailFlags) {
      if (config.vars[flag] !== "false") errors.push(`${label} ${flag} must remain exactly false for the no-email portal release`);
    }
  }
  return errors;
}
