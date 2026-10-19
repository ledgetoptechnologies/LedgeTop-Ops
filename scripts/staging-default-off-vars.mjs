/** These eight Ops gates enable only on the literal string "true" at runtime.
 * Omission is an approved staging representation of their existing off state.
 * This is not a general default for missing settings or production config. */
export const STAGING_OPTIONAL_DEFAULT_OFF_FLAGS = Object.freeze({
  operations: Object.freeze([
    "PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED",
    "PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED",
    "PROJECT_ALPHA_DRAFT_QUOTES_ENABLED",
    "PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED",
    "PROJECT_ALPHA_DELIVERY_GUEST_ENABLED",
    "PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ACCEPTANCE_ENABLED",
    "AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED",
    "PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED",
  ]),
});

/** Validation view only. Never turn an explicitly supplied invalid value off. */
export function normalizedStagingVars(app, vars) {
  const normalized = { ...vars };
  for (const flag of STAGING_OPTIONAL_DEFAULT_OFF_FLAGS[app] ?? []) {
    if (!Object.hasOwn(normalized, flag)) normalized[flag] = "false";
  }
  return normalized;
}

/** Render fewer bindings without rewriting explicit activations or other vars. */
export function compactStagingVars(app, vars) {
  const compact = { ...vars };
  for (const flag of STAGING_OPTIONAL_DEFAULT_OFF_FLAGS[app] ?? []) {
    if (compact[flag] === "false") delete compact[flag];
  }
  return compact;
}
